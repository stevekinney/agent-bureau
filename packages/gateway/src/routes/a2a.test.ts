import type {
  ActiveRun,
  CombinedOperativeEventMap,
  GenerateFunction,
} from '@lostgradient/operative';
import { HumanWaitParkedEvent } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import type { Bureau } from 'bureau';
import { CompletableEventTarget, createManualRuntimeServices } from 'lifecycle';

import {
  attackerRequestContextFixture,
  createGatewayAuthorityTestApiKey,
  createTestGateway,
  expectedPersistedApiKeyAuthority,
  requestJSON,
} from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

/**
 * Builds a bare-bones `ActiveRun` a test can `store.register()` directly to
 * simulate a durable run parked on `requestHumanInput` without a full
 * generate/toolbox-driven run — mirrors `reviews.test.ts`'s
 * `createParkedActiveRun` and `bureau`'s `create-bureau.test.ts` recipe of
 * the same name.
 */
function createParkedActiveRun(): {
  activeRun: ActiveRun;
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
} {
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const activeRun: ActiveRun = {
    result: new Promise<never>(() => {}),
    abort: () => {},
    // AB-204: mechanical addition — this never-settling parked stub has no
    // cleanup to await, matching `abort`'s never-resolving `result` above.
    closed: () => new Promise(() => {}),
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete: emitter.complete.bind(emitter),
    // AB-214: mechanical addition — this never-settling stub run reports a
    // static 'running' snapshot and delivers it once; matching `abort`'s
    // never-resolving `result` above, it never reaches a revision change.
    snapshot: () => ({
      id: 'parked',
      kind: 'agent-run',
      startedAt: new Date(0).toISOString(),
      revision: 0,
      status: 'running',
      lastTransitionAt: new Date(0).toISOString(),
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: true,
      attempt: 0,
      reachability: 'unknown',
      progress: 'unknown',
      assessment: 'healthy',
      observedAt: 0,
      missedPulseCount: 0,
      policyVersion: 'ab-88/2026-09-01',
      evidence: [],
    }),
    subscribeSnapshot: (observer) => {
      observer(activeRun.snapshot());
      return { unsubscribe: () => {}, closed: false };
    },
    [Symbol.dispose]: () => {},
  };
  return { activeRun, emitter };
}

function registerParkedRun(bureau: Bureau, name: string, prompt: string): string {
  const { activeRun, emitter } = createParkedActiveRun();
  const runId = bureau.store.register(activeRun, name);
  emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, prompt));
  return runId;
}

async function sendMessage(
  gatewayApp: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  body: unknown,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('content-type', 'application/json');
  const response = await gatewayApp.request('/a2a', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('A2A JSON-RPC endpoint (POST /a2a)', () => {
  // ── JSON-RPC envelope handling (Section 9.3/9.5 of the spec) ───────────

  it('returns -32700 JSONParseError for an unparseable body', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await gateway.app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.jsonrpc).toBe('2.0');
    expect(responseBody.id).toBeNull();
    expect(responseBody.error.code).toBe(-32700);
  });

  it('returns -32600 InvalidRequestError for a payload missing jsonrpc/method', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { status, body } = await sendMessage(gateway.app, { id: 7, params: {} });
    expect(status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32600);
  });

  it('returns -32601 MethodNotFoundError for an unknown method', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ListTasks',
      params: {},
    });
    expect(status).toBe(200);
    expect(body.error.code).toBe(-32601);
  });

  it('returns -32004 UnsupportedOperationError for SendStreamingMessage — streaming is a documented follow-up', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendStreamingMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    });
    expect(body.error.code).toBe(-32004);
  });

  it('returns -32602 InvalidParamsError when SendMessage params fail validation', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', parts: [] } },
    });
    expect(body.error.code).toBe(-32602);
  });

  // ── SendMessage — new task ──────────────────────────────────────────────

  it('SendMessage creates a task and blocks until it completes, returning an artifact', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'What is 2 + 2?' }] },
      },
    });

    expect(status).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    const task = body.result.task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts).toEqual([
      { artifactId: `${task.id}:result`, name: 'Result', parts: [{ text: 'Done.' }] },
    ]);
    expect(task.contextId).toBeTruthy();
  });

  it("a parked task's status.message.messageId (AB-327) follows the injected RuntimeServices identifiers, not crypto.randomUUID()", async () => {
    const runtime = createManualRuntimeServices();
    const gateway = await createTestGateway({ generate: createMockGenerate(), runtime });
    const taskId = registerParkedRun(gateway.bureau, 'a2a-parked-run', 'What is your name?');

    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: taskId },
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(body.result.task.status.message.messageId).toStartWith(
      `${runtime.identifierPrefix}-a2a-message-`,
    );
  });

  it('SendMessage derives request authority from the verified API key and ignores caller context', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      storage: { type: 'memory' },
    });
    const { key, plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const { status, body } = await sendMessage(
      gateway.app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          requestContext: attackerRequestContextFixture(),
          message: {
            messageId: 'm1',
            role: 'ROLE_USER',
            parts: [{ text: 'Hello' }],
            requestContext: attackerRequestContextFixture(),
          },
        },
      },
      { authorization: `Bearer ${plaintext}` },
    );

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();

    const session = await gateway.bureau.getSession(body.result.task.contextId);
    expect(session?.metadata['lastRequestAuthority']).toEqual(
      expectedPersistedApiKeyAuthority(key, 'bureau'),
    );
  });

  it('SendMessage with returnImmediately: true does not block on run completion', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] },
        configuration: { returnImmediately: true },
      },
    });
    expect(status).toBe(200);
    // Non-blocking: state is whatever the run happens to be in right after
    // registration — SUBMITTED, WORKING, or (for a very fast mock generate
    // that settles before this returns) already COMPLETED. All are
    // spec-legal for the non-blocking response; assert it's a real task.
    expect(typeof body.result.task.id).toBe('string');
  });

  it('SendMessage on a run that fails maps to TASK_STATE_FAILED with an error status message', async () => {
    const gateway = await createTestGateway({
      generate: async () => {
        throw new Error('boom');
      },
    });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    });
    const task = body.result.task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.status.message.role).toBe('ROLE_AGENT');
    expect(typeof task.status.message.parts[0].text).toBe('string');
  });

  it('SendMessage with an unknown taskId returns TaskNotFoundError', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm1', role: 'ROLE_USER', taskId: 'nope', parts: [{ text: 'Hi' }] },
      },
    });
    expect(body.error.code).toBe(-32001);
  });

  it('SendMessage with a taskId on a task that is not input-required returns UnsupportedOperationError', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const created = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    });
    const taskId = created.body.result.task.id;

    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm2', role: 'ROLE_USER', taskId, parts: [{ text: 'follow-up' }] },
      },
    });
    expect(body.error.code).toBe(-32004);
  });

  // ── SendMessage — resuming an input-required task (AB-20/21 park) ──────

  it('SendMessage with taskId resumes a parked task via Bureau.resolveReview/signalSession', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    // `bureau.signalSession` needs a durable engine + real session to route
    // to — mocked here exactly like bureau's own
    // "resolveReview approve on a human-wait review signals the parked
    // session" test, since this fake run has neither. What's under test is
    // that the A2A resume path forwards the message text as the signal
    // payload, not signalSession's real routing (already covered elsewhere).
    const signalSpy = spyOn(gateway.bureau, 'signalSession').mockImplementation(async () => {});
    const taskId = registerParkedRun(gateway.bureau, 'a2a-parked-run', 'What is your name?');

    const getParked = await requestJSON(gateway, `/a2a`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'GetTask',
        params: { id: taskId },
      }),
    });
    const parkedBody = await getParked.json();
    expect(parkedBody.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(parkedBody.result.task.status.message.parts[0].text).toBe('What is your name?');

    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm2', role: 'ROLE_USER', taskId, parts: [{ text: 'Ferris' }] },
        // Real (blocking) wait would hang forever here — the fake ActiveRun's
        // `result` promise never resolves and the mocked `signalSession`
        // never drives the workflow forward, so the same fake-run limitation
        // `create-bureau.test.ts` documents applies here too.
        configuration: { returnImmediately: true },
      },
    });

    expect(status).toBe(200);
    expect(signalSpy).toHaveBeenCalledWith('', 'human-response', 'Ferris');
    expect(body.result.task.id).toBe(taskId);
  });

  it("SendMessage's blocking resume settles via awaitTerminalOrInterrupted's re-park event branch (AB-316)", async () => {
    // `awaitTerminalOrInterrupted` races `activeRun.result` against a
    // 'multiagent.human-wait.parked' listener. Every OTHER test in this file
    // either passes `returnImmediately: true` (skips the race entirely) or
    // lets `activeRun.result` settle first (the resume test above explicitly
    // notes a real blocking wait "would hang forever" against this fixture's
    // never-resolving `result`). This test exercises the race's OTHER
    // branch: the resumed run re-parks (asks a follow-up) WHILE the wait is
    // in flight. Deterministically, not by timing — dispatching the event
    // from inside a wrapped `addEventListener` fires it the instant
    // `awaitTerminalOrInterrupted` subscribes, on the same synchronous call
    // stack, rather than racing a real clock.
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const signalSpy = spyOn(gateway.bureau, 'signalSession').mockImplementation(async () => {});
    const { activeRun, emitter } = createParkedActiveRun();
    const taskId = gateway.bureau.store.register(activeRun, 'a2a-reparked-run');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', taskId, 'What is your name?'));

    const baseAddEventListener = activeRun.addEventListener.bind(activeRun);
    activeRun.addEventListener = (type, listener, options) => {
      baseAddEventListener(type, listener, options);
      if (type === 'multiagent.human-wait.parked') {
        emitter.dispatchEvent(
          new HumanWaitParkedEvent('human-response', taskId, 'And your quest?'),
        );
      }
    };

    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm2', role: 'ROLE_USER', taskId, parts: [{ text: 'Ferris' }] },
        // No `returnImmediately` — this is the blocking path, which is
        // exactly what needs `awaitTerminalOrInterrupted` to actually settle.
      },
    });

    expect(status).toBe(200);
    expect(signalSpy).toHaveBeenCalledWith('', 'human-response', 'Ferris');
    expect(body.result.task.id).toBe(taskId);
  });

  it("SendMessage's blocking resume settles via awaitTerminalOrInterrupted's swallowed activeRun.result rejection (AB-316)", async () => {
    // The race's OTHER branch: `activeRun.result.catch(() => undefined)`.
    // This only runs when `result` itself rejects — every other test's fixed
    // `result` either never settles or (via the real bureau path) resolves
    // with a RunResult that encodes failure as DATA (`finishReason: 'error'`)
    // rather than a promise rejection, so nothing else in this file reaches
    // it. Here `result` is a genuinely rejected promise the fixture never
    // otherwise produces.
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const signalSpy = spyOn(gateway.bureau, 'signalSession').mockImplementation(async () => {});
    const { activeRun, emitter } = createParkedActiveRun();
    activeRun.result = Promise.reject(
      new Error('synthetic activeRun.result rejection (AB-316 coverage)'),
    );
    const taskId = gateway.bureau.store.register(activeRun, 'a2a-rejecting-run');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', taskId, 'What is your name?'));

    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm2', role: 'ROLE_USER', taskId, parts: [{ text: 'Ferris' }] },
      },
    });

    expect(status).toBe(200);
    expect(signalSpy).toHaveBeenCalledWith('', 'human-response', 'Ferris');
    expect(body.result.task.id).toBe(taskId);
  });

  // ── GetTask ──────────────────────────────────────────────────────────────

  it('GetTask returns TaskNotFoundError for an unknown id', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: 'nope' },
    });
    expect(body.error.code).toBe(-32001);
  });

  it('GetTask truncates history to the requested historyLength', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const created = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    });
    const taskId = created.body.result.task.id;

    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'GetTask',
      params: { id: taskId, historyLength: 0 },
    });
    expect(body.result.task.history).toEqual([]);
  });

  // ── CancelTask ───────────────────────────────────────────────────────────

  it('CancelTask cancels a running task', async () => {
    // A generate that never resolves keeps the run genuinely 'running' (not
    // a fake registered run) so `Bureau.abortRun`'s real cooperative-cancel
    // path flips the store's status — mirrors bureau's own "aborts a running
    // run" test recipe (`create-bureau.test.ts`).
    const gateway = await createTestGateway({ generate: () => new Promise(() => {}) });
    const created = await gateway.app.request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Run forever' }),
    });
    const createdBody = await created.json();
    const taskId = createdBody.id;

    const { status, body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'CancelTask',
      params: { id: taskId },
    });
    expect(status).toBe(200);
    expect(body.result.task.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('CancelTask returns TaskNotCancelableError for an already-terminal task', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const created = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    });
    const taskId = created.body.result.task.id;

    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'CancelTask',
      params: { id: taskId },
    });
    expect(body.error.code).toBe(-32002);
  });

  it('CancelTask returns TaskNotFoundError for an unknown id', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const { body } = await sendMessage(gateway.app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'CancelTask',
      params: { id: 'nope' },
    });
    expect(body.error.code).toBe(-32001);
  });
});
