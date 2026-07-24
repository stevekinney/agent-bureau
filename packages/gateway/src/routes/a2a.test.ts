import type {
  ActiveRun,
  CombinedOperativeEventMap,
  GenerateFunction,
} from '@lostgradient/operative';
import { HumanWaitParkedEvent } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import type { Bureau } from 'bureau';
import { CompletableEventTarget } from 'lifecycle';

import { createTestGateway, requestJSON } from '../test';

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
    addEventListener: emitter.addEventListener.bind(emitter) as ActiveRun['addEventListener'],
    removeEventListener: emitter.removeEventListener.bind(
      emitter,
    ) as ActiveRun['removeEventListener'],
    on: emitter.on.bind(emitter) as ActiveRun['on'],
    once: emitter.once.bind(emitter) as ActiveRun['once'],
    subscribe: emitter.subscribe.bind(emitter) as ActiveRun['subscribe'],
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete: emitter.complete.bind(emitter),
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
) {
  const response = await gatewayApp.request('/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
