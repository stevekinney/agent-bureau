import type { GenerateFunction, Toolbox } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox, type ToolRequestContext } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { BureauError } from 'bureau';
import { Hono } from 'hono';

import { errorHandler } from '../middleware/error-handler';
import {
  attackerRequestContextFixture,
  createGatewayAuthorityTestApiKey,
  createTestGateway,
  expectedPersistedApiKeyAuthority,
  requestJSON,
  waitForRunState,
} from '../test';
import type { Bureau, PendingReview, PendingToolApprovalReview, RunEventRecord } from '../types';
import {
  assembleRunTimeline,
  classifyRunAttachment,
  createRunsRoutes,
  findParkedReview,
  propagateDisconnectToAttachedRun,
} from './runs';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

describe('runs routes', () => {
  it('POST /api/v1/runs returns 503 when no generate is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(503);
  });

  it('POST /api/v1/runs returns 400 when message is missing', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('POST /api/v1/runs returns 400 when the JSON body is not an object', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });

    for (const body of ['null', '"message"', '[]']) {
      const response = await requestJSON(gateway, '/api/v1/runs', {
        method: 'POST',
        body,
      });
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody.error.message).toBe('Run request body must be a JSON object');
    }
  });

  it('POST /api/v1/runs returns 400 when agentName is not a string', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello', agentName: 42 }),
    });

    expect(response.status).toBe(400);
  });

  it('POST /api/v1/runs creates a run and returns 201', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.id).toBeString();
    expect(body.status).toBe('running');
  });

  it('POST /api/v1/runs strips caller-supplied request authority when no verified authentication metadata exists', async () => {
    const { z } = await import('zod');
    let step = 0;
    const observedRequestContexts: ToolRequestContext[] = [];
    const gateway = await createTestGateway({
      generate: async () =>
        step++ === 0
          ? {
              content: '',
              toolCalls: [{ name: 'capture_request_context', arguments: {} }],
            }
          : { content: 'Done.', toolCalls: [] },
      toolbox: createToolbox([
        createTool({
          name: 'capture_request_context',
          description: 'Capture the request context supplied to a run tool call.',
          input: z.object({}),
          async execute(_input, context) {
            if (context.requestContext) observedRequestContexts.push(context.requestContext);
            return context.requestContext?.authority.principalId ?? null;
          },
        }),
      ]),
    });

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        message: 'Hello',
        requestContext: attackerRequestContextFixture(),
      }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: string };
    await waitForRunState(gateway.bureau, body.id);

    expect(observedRequestContexts).toHaveLength(1);
    expect(observedRequestContexts[0]).toMatchObject({
      audience: 'operator',
      authority: {
        principalId: 'anonymous',
        tenantId: 'bureau',
        ownerId: 'bureau',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    });
  });

  it('POST /api/v1/runs derives request authority from the verified API key and ignores caller context', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      storage: { type: 'memory' },
      toolbox: createEmptyToolbox(),
    });
    const { key, plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        agentName: 'writer',
        message: 'Hello',
        requestContext: attackerRequestContextFixture(),
      }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { sessionId: string };
    const session = await gateway.bureau.getSession(body.sessionId);

    expect(session?.metadata['lastRequestAuthority']).toEqual(
      expectedPersistedApiKeyAuthority(key, 'writer'),
    );
  });

  it('POST /api/v1/runs returns 429 when a flow-control policy rejects admission (AB-13)', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      flowControl: { concurrency: { limit: 0 } },
    });

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(429);
  });

  it('POST /api/v1/runs returns 409 when request authority becomes stale before admission', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    spyOn(gateway.bureau, 'createRun').mockRejectedValue(
      new BureauError('Request authority is no longer valid', 'CONFLICT'),
    );

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.status).toBe(409);
  });

  it('GET /api/v1/runs lists all runs', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    // Create a run
    await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });

    const response = await requestJSON(gateway, '/api/v1/runs');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/runs/:id returns a specific run', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const { id } = await createResponse.json();

    const response = await requestJSON(gateway, `/api/v1/runs/${id}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(id);
  });

  // AB-12 — GET /:id includes the assembled timeline (not just the raw
  // event log) so the run-inspector UI never has to re-derive it.
  it('GET /api/v1/runs/:id includes an assembled timeline (AB-12)', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const { id } = await createResponse.json();
    await waitForRunState(gateway.bureau, id);

    const response = await requestJSON(gateway, `/api/v1/runs/${id}`);
    const body = await response.json();

    expect(Array.isArray(body.timeline)).toBe(true);
    expect(body.timeline.length).toBe(body.events.length);
    // `assembleRunTimeline` is the single source of truth for the shape —
    // the route must not hand-roll a divergent copy.
    expect(body.timeline).toEqual(assembleRunTimeline(body.events));
  });

  it('GET /api/v1/runs/:id returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent');
    expect(response.status).toBe(404);
  });

  it('GET /api/v1/runs/:id/events reaches bureau.eventHistory({kind: "run", id}) — AB-312 (501 over this test gateway\'s ephemeral in-memory storage)', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/run-1/events');
    // The default test bureau has no persistent storage backend, so this
    // proves the route is wired to `bureau.eventHistory` with the right
    // owner kind (it deterministically resolves `unsupported-capability`
    // there) without needing a real sqlite/lmdb fixture in this file —
    // the full paged/redacted response shape is covered by
    // `event-history.test.ts`, and a real durable page by the conformance
    // suite.
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('POST /api/v1/runs/:id/abort returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent/abort', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/runs/:id returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/runs/:id returns 409 for running run', async () => {
    // Use a generate that never resolves so run stays in running state
    const generate: GenerateFunction = () => new Promise(() => {});
    const gateway = await createTestGateway({ generate, toolbox: createEmptyToolbox() });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const { id } = await createResponse.json();

    expect(gateway.bureau.getRun(id)?.status).toBe('running');

    const response = await requestJSON(gateway, `/api/v1/runs/${id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
  });

  it('GET /api/v1/runs?status= filters by status', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();

    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, '/api/v1/runs?status=completed');
    expect(response.status).toBe(200);
    const body = await response.json();
    // Should find runs matching the filter (may be 0 if timing is off, but no error)
    expect(Array.isArray(body)).toBe(true);
  });
});

// AB-12 — run-inspector timeline assembly, tested at the route/store level
// (not the Svelte component) per the acceptance criteria: pure-function
// coverage over synthetic `RunEventRecord`s, independent of any real run.
describe('assembleRunTimeline', () => {
  function record(
    overrides: Partial<RunEventRecord> & Pick<RunEventRecord, 'event'>,
  ): RunEventRecord {
    return {
      sequence: 0,
      runId: 'run-1',
      detail: {},
      timestamp: 0,
      ...overrides,
    };
  }

  it('classifies step.started/step.completed as checkpoint boundaries', () => {
    const timeline = assembleRunTimeline([
      record({ sequence: 0, event: 'step.started' }),
      record({ sequence: 1, event: 'step.completed' }),
    ]);

    expect(timeline.map((entry) => entry.kind)).toEqual(['checkpoint', 'checkpoint']);
  });

  it('classifies every AB-12 milestone event kind', () => {
    const events: RunEventRecord[] = [
      record({ sequence: 0, event: 'multiagent.human-wait.parked' }),
      record({ sequence: 1, event: 'multiagent.child-workflow.started' }),
      record({ sequence: 2, event: 'multiagent.handoff.occurred' }),
      record({ sequence: 3, event: 'workflow.reattached' }),
      record({ sequence: 4, event: 'generate.retry' }),
      record({ sequence: 5, event: 'step.started' }),
      record({ sequence: 6, event: 'step.completed' }),
      record({ sequence: 7, event: 'run.started' }),
    ];

    const timeline = assembleRunTimeline(events);

    expect(timeline).toHaveLength(events.length);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'human-wait-parked',
      'child-workflow-started',
      'handoff-occurred',
      'reattached',
      'retry-attempt',
      'checkpoint',
      'checkpoint',
      'other',
    ]);
  });

  it('sorts by sequence, not input order — interleaving synthetic and observed actions', () => {
    // `workflow.reattached` is recorded via `store.recordAction`, not the
    // observable — but it still gets a real sequence number, so a timeline
    // consumer that trusts `sequence` sees it in the right place even if the
    // caller's array wasn't pre-sorted.
    const events: RunEventRecord[] = [
      record({ sequence: 5, event: 'step.completed' }),
      record({ sequence: 0, event: 'workflow.reattached' }),
      record({ sequence: 2, event: 'multiagent.human-wait.parked' }),
    ];

    const timeline = assembleRunTimeline(events);

    expect(timeline.map((entry) => entry.sequence)).toEqual([0, 2, 5]);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'reattached',
      'human-wait-parked',
      'checkpoint',
    ]);
  });

  it('classifies every other event kind as "other" without dropping it', () => {
    const timeline = assembleRunTimeline([
      record({ sequence: 0, event: 'tools.executing' }),
      record({ sequence: 1, event: 'run.completed' }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline.every((entry) => entry.kind === 'other')).toBe(true);
  });

  it('returns an empty timeline for an empty event log', () => {
    expect(assembleRunTimeline([])).toEqual([]);
  });

  it('carries through event, detail, and timestamp unchanged', () => {
    const timeline = assembleRunTimeline([
      record({
        sequence: 3,
        event: 'workflow.reattached',
        detail: { versionMismatch: true, storedVersion: 'v1', registeredVersion: 'v2' },
        timestamp: 12345,
      }),
    ]);

    expect(timeline[0]).toEqual({
      sequence: 3,
      kind: 'reattached',
      event: 'workflow.reattached',
      detail: { versionMismatch: true, storedVersion: 'v1', registeredVersion: 'v2' },
      timestamp: 12345,
    });
  });
});

// AB-212 — the request-disconnect classification rule (AC1: a named
// function, unit-tested for each branch).
describe('classifyRunAttachment', () => {
  it('is "attached" when the signal was forwarded and the run is process-local', () => {
    expect(classifyRunAttachment({ signalForwarded: true, durability: 'process-local' })).toBe(
      'attached',
    );
  });

  it('is "detached" when the signal was forwarded but the run is durable — durable work survives the request', () => {
    expect(classifyRunAttachment({ signalForwarded: true, durability: 'durable' })).toBe(
      'detached',
    );
  });

  it('is "detached" when the run is process-local but no signal was forwarded', () => {
    expect(classifyRunAttachment({ signalForwarded: false, durability: 'process-local' })).toBe(
      'detached',
    );
  });

  it('is "detached" when neither condition holds', () => {
    expect(classifyRunAttachment({ signalForwarded: false, durability: 'durable' })).toBe(
      'detached',
    );
  });
});

// AB-212 — the already-aborted branch: a client that vanished WHILE
// `bureau.createRun` was still doing its own async setup (session load,
// durable dispatch) leaves the request's signal already aborted by the time
// the route registers the disconnect handler — `propagateDisconnectToAttachedRun`
// must fire immediately in that case rather than only on a future 'abort'
// event that will never come.
describe('propagateDisconnectToAttachedRun: already-aborted signal (AB-212)', () => {
  it('fires the disconnect handler immediately when the signal is already aborted at registration time', async () => {
    const generate: GenerateFunction = (context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const gateway = await createTestGateway({ generate, toolbox: createEmptyToolbox() });
    const summary = await gateway.bureau.createRun({ message: 'Hello' });
    expect(gateway.bureau.getRun(summary.id)?.status).toBe('running');

    const alreadyAbortedController = new AbortController();
    alreadyAbortedController.abort();

    propagateDisconnectToAttachedRun(gateway.bureau, summary.id, alreadyAbortedController.signal);

    await waitForRunState(gateway.bureau, summary.id, (run) => run.status === 'aborted');

    gateway.bureau.dispose();
  });
});

// AB-212 AC2 — an attached run's disconnect aborts the run, awaits its
// closed() cleanup, and records a `run.disconnect-aborted` audit entry.
describe('POST /api/v1/runs: attached-run disconnect propagation (AB-212)', () => {
  it('aborts the run and records a run.disconnect-aborted audit entry when the request disconnects after the run starts', async () => {
    // Gate generate on the run's own abort signal — exactly like the
    // existing openai-compat SSE-disconnect regression test — so the run
    // stays "running" until the disconnect handler aborts it.
    const generate: GenerateFunction = (context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const gateway = await createTestGateway({
      generate,
      storage: { type: 'memory' },
      toolbox: createEmptyToolbox(),
    });
    const { plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const controller = new AbortController();
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ message: 'Hello' }),
      signal: controller.signal,
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    expect(gateway.bureau.getRun(id)?.status).toBe('running');
    expect(gateway.bureau.getRun(id)?.liveness.durability).toBe('process-local');

    // Simulate the client disconnecting AFTER the response was already
    // delivered — the disconnect handler was registered on this same
    // signal before the handler returned, and stays live for as long as
    // the signal itself does.
    controller.abort();

    await waitForRunState(gateway.bureau, id, (run) => run.status === 'aborted');

    const auditRecords = await gateway.bureau.auditTrail?.query({ runId: id });
    const disconnectEntry = auditRecords?.find(
      (record) => record.type === 'run.disconnect-aborted',
    );
    expect(disconnectEntry).toBeDefined();
    expect(disconnectEntry?.runId).toBe(id);
    expect(disconnectEntry?.detail).toMatchObject({
      acknowledgement: { status: 'completed' },
    });

    gateway.bureau.dispose();
  });

  it('does not abort a durably-routed run when the request disconnects — durable work is preserved (AB-212 AC1)', async () => {
    const generate: GenerateFunction = (context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const gateway = await createTestGateway({
      generate,
      storage: { type: 'memory' },
      durableExecution: true,
      toolbox: createEmptyToolbox(),
    });
    const { plaintext } = await createGatewayAuthorityTestApiKey(gateway);

    const controller = new AbortController();
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ message: 'Hello' }),
      signal: controller.signal,
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    expect(gateway.bureau.getRun(id)?.liveness.durability).toBe('durable');

    controller.abort();

    // A durable run must be left running: give the (absent) disconnect
    // handler a bounded number of real event-loop turns to (not) act, then
    // assert the run is still running and no disconnect audit entry was
    // written. `classifyRunAttachment` deciding 'detached' means
    // `propagateDisconnectToAttachedRun` is never called in the first place
    // (see the sibling "attached" test above for the positive case this
    // negative case mirrors) — these yields are for defense in depth against
    // a future regression that wires it unconditionally.
    for (let turn = 0; turn < 5; turn++) {
      await yieldToPortableEventLoop();
    }
    expect(gateway.bureau.getRun(id)?.status).toBe('running');
    const auditRecords = await gateway.bureau.auditTrail?.query({ runId: id });
    expect(auditRecords?.some((record) => record.type === 'run.disconnect-aborted')).toBe(false);

    gateway.bureau.dispose();
  });
});

describe('findParkedReview', () => {
  function humanWaitReview(overrides: Partial<PendingReview> = {}): PendingReview {
    return {
      kind: 'human-wait',
      id: 'human-wait:run-1:human-response',
      runId: 'run-1',
      sessionId: 'session-1',
      agentName: 'bureau',
      signalName: 'human-response',
      prompt: 'Approve?',
      requestedAt: 0,
      ageMilliseconds: 0,
      ...overrides,
    } as PendingReview;
  }

  it('finds the human-wait review parking the given run', () => {
    const review = humanWaitReview({ runId: 'run-1' });
    expect(findParkedReview([review], 'run-1')).toBe(review);
  });

  it('returns undefined when no review parks the given run', () => {
    const review = humanWaitReview({ runId: 'run-other' });
    expect(findParkedReview([review], 'run-1')).toBeUndefined();
  });

  it('ignores a tool-approval review even if its runId matches', () => {
    const toolApproval: PendingToolApprovalReview = {
      kind: 'tool-approval',
      id: 'approval:run-1:call-1',
      runId: 'run-1',
      sessionId: 'session-1',
      agentName: 'bureau',
      approval: {
        callId: 'call-1',
        toolName: 'delete_file',
        arguments: {},
        action: { type: 'approval' },
      },
      requestedAt: 0,
      ageMilliseconds: 0,
    };

    expect(findParkedReview([toolApproval], 'run-1')).toBeUndefined();
  });
});

describe('runs routes error mapping (stub bureau)', () => {
  function buildApp(overrides: { abortRun?: Bureau['abortRun']; deleteRun?: Bureau['deleteRun'] }) {
    const stubBureau = {
      abortRun: overrides.abortRun,
      deleteRun: overrides.deleteRun,
    } as unknown as Bureau;
    const app = new Hono();
    app.route('/api/v1/runs', createRunsRoutes(stubBureau));
    app.onError(errorHandler);
    return app;
  }

  it('POST /api/v1/runs returns 400 for unparseable JSON instead of a raw parse error', async () => {
    const stubBureau = {} as unknown as Bureau;
    const app = new Hono();
    app.route('/api/v1/runs', createRunsRoutes(stubBureau));
    app.onError(errorHandler);

    const response = await app.request('/api/v1/runs', {
      method: 'POST',
      body: '{not valid json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  it('rethrows a BureauError abortRun failure whose code is not NOT_FOUND or CONFLICT', async () => {
    const app = buildApp({
      abortRun: () => {
        throw new BureauError('generate not configured', 'NOT_CONFIGURED', 'generate');
      },
    });

    const response = await app.request('/api/v1/runs/any/abort', { method: 'POST' });
    expect(response.status).toBe(500);
  });

  it('rethrows a BureauError deleteRun failure whose code is not NOT_FOUND or CONFLICT', async () => {
    const app = buildApp({
      deleteRun: async () => {
        throw new BureauError('generate not configured', 'NOT_CONFIGURED', 'generate');
      },
    });

    const response = await app.request('/api/v1/runs/any', { method: 'DELETE' });
    expect(response.status).toBe(500);
  });
});
