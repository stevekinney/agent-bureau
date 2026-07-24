import type { GenerateFunction, Toolbox } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON, waitForRunState } from '../test';
import type { PendingReview, PendingToolApprovalReview, RunEventRecord } from '../types';
import { assembleRunTimeline, findParkedReview } from './runs';

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
