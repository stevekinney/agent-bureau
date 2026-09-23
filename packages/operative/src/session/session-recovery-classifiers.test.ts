import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import { reconcileTerminalRunRef } from './session-handle-support';
import {
  alreadyTerminalError,
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
  seedRunningSession,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — terminal classifiers', () => {
  it('reconciles a genuinely cancelled Weft-level workflow to "aborted"', async () => {
    const sessionId = 'ab-28-cancelled-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'cancelled');
      },
      get: async (id: string) => ({ id, status: 'cancelled' }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_id: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    const run = persisted?.runs.find((r) => r.runId === runId);
    expect(run?.status).toBe('aborted');
    expect(run?.outcome).toEqual({
      finishReason: 'aborted',
      error: { kind: 'abort', code: 'ABORTED' },
    });
  });

  it.each([
    {
      name: 'maximum-steps',
      finishReason: 'maximum-steps',
      expected: {
        finishReason: 'maximum-steps',
        error: { kind: 'policy', code: 'MAXIMUM_STEPS' },
      },
    },
    {
      name: 'aborted',
      finishReason: 'aborted',
      expected: { finishReason: 'aborted', error: { kind: 'abort', code: 'ABORTED' } },
    },
    {
      name: 'elicitation denied',
      finishReason: 'elicitation-denied',
      expected: {
        finishReason: 'elicitation-denied',
        error: { kind: 'policy', code: 'ELICITATION_DENIED' },
      },
    },
    {
      name: 'budget exceeded',
      finishReason: 'budget-exceeded',
      expected: {
        finishReason: 'budget-exceeded',
        error: { kind: 'policy', code: 'BUDGET_EXCEEDED' },
      },
    },
    {
      name: 'tripwire',
      finishReason: 'tripwire',
      expected: { finishReason: 'tripwire', error: { kind: 'policy', code: 'TRIPWIRE' } },
    },
    {
      name: 'default error classifier',
      finishReason: 'error',
      errorMessage: 'private default error canary',
      expected: { finishReason: 'error', error: { kind: 'generate', code: 'UNKNOWN' } },
    },
    {
      name: 'maximum-steps precedence',
      finishReason: 'maximum-steps',
      errorKind: 'generate',
      errorCode: 'UNKNOWN',
      expected: {
        finishReason: 'maximum-steps',
        error: { kind: 'policy', code: 'MAXIMUM_STEPS' },
      },
    },
    {
      name: 'explicit classifier',
      finishReason: 'error',
      errorMessage: 'private classifier canary',
      errorKind: 'policy',
      errorCode: 'TRIPWIRE',
      expected: { finishReason: 'error', error: { kind: 'policy', code: 'TRIPWIRE' } },
    },
    {
      name: 'schema failure fallback',
      finishReason: 'stop-condition',
      schemaValidation: { success: false, error: 'private schema canary' },
      expected: {
        finishReason: 'stop-condition',
        error: { kind: 'output', code: 'INVALID_OUTPUT' },
      },
    },
    {
      name: 'successful stop',
      finishReason: 'stop-condition',
      expected: { finishReason: 'stop-condition' },
    },
  ])('preserves detached completed classifier: $name', async (caseData) => {
    const sessionId = `ab-28-completed-classifier-${caseData.name.replaceAll(' ', '-')}`;
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const fakeEngine = createSessionEngine({
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId: id,
          steps: 1,
          content: 'done',
          finishReason: caseData.finishReason,
          ...('errorMessage' in caseData ? { errorMessage: caseData.errorMessage } : {}),
          ...('errorKind' in caseData ? { errorKind: caseData.errorKind } : {}),
          ...('errorCode' in caseData ? { errorCode: caseData.errorCode } : {}),
          ...('schemaValidation' in caseData
            ? { schemaValidation: caseData.schemaValidation }
            : {}),
        },
      }),
    });
    const checkpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));

    await reconcileTerminalRunRef(store, fakeEngine, checkpointStore, sessionId, {
      runId,
      sequence: 0,
      status: 'running',
      startedAt: fixtureRuntime.clock.nowISO(),
      agentName: 'agent',
    });

    const persisted = await store.load(sessionId);
    expect(persisted?.runs[0]?.outcome).toEqual(caseData.expected);
    expect(JSON.stringify(persisted?.runs[0]?.outcome)).not.toContain('private');
  });

  it.each([
    {
      status: 'cancelled',
      expected: { finishReason: 'aborted', error: { kind: 'abort', code: 'ABORTED' } },
    },
    { status: 'failed', expected: { finishReason: 'error' } },
    {
      status: 'timed-out',
      expected: { finishReason: 'error', error: { kind: 'generate', code: 'UNKNOWN' } },
    },
  ] as const)(
    'preserves detached engine-state classifier: $status',
    async ({ status, expected }) => {
      const sessionId = `ab-28-engine-classifier-${status}`;
      const runId = `${sessionId}:0`;
      const store = await seedRunningSession(sessionId, runId);
      const fakeEngine = createSessionEngine({
        get: async (id: string) => ({ id, status, error: 'private engine canary' }),
      });
      const checkpointStore = createCheckpointStoreFixture(async () => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }));

      await reconcileTerminalRunRef(store, fakeEngine, checkpointStore, sessionId, {
        runId,
        sequence: 0,
        status: 'running',
        startedAt: fixtureRuntime.clock.nowISO(),
        agentName: 'agent',
      });

      const persisted = await store.load(sessionId);
      expect(persisted?.runs[0]?.outcome).toEqual(expected);
      expect(JSON.stringify(persisted?.runs[0]?.outcome)).not.toContain('private');
    },
  );

  it('reconciles a genuinely failed Weft-level workflow to "error"', async () => {
    const sessionId = 'ab-28-failed-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'failed');
      },
      get: async (id: string) => ({ id, status: 'failed', error: 'engine blew up' }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_id: string) => {
      throw new Error('no checkpoint was ever written for this run');
    });

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    const run = persisted?.runs.find((r) => r.runId === runId);
    expect(run?.status).toBe('error');
    expect(run?.outcome).toEqual({ finishReason: 'error' });
  });
});
