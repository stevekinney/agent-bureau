import { TypedEventTarget } from '@lostgradient/lifecycle';
import {
  MemoryStorage,
  textValueStore,
  workflow,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import { createRunEngine } from '../durable/create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import type { OperativeEventMap, SessionRecoverEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
  makeProbeWorkflow,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — mixed outcomes and failures', () => {
  it('AB-29: a mixed outcome reports the newer rejection alongside the older successful reattach', async () => {
    const storage = new MemoryStorage();
    const sessionId = 'd2-mixed-outcome-session';
    const olderRunId = `${sessionId}:0`;
    // Never actually started durably — engine.resume() will reject for this one.
    const newerRunId = `${sessionId}:1`;
    const enteredWorkflow = Promise.withResolvers<void>();
    const parkedWorkflow = workflow({ name: 'agentRun' }).execute(async function* (ctx) {
      enteredWorkflow.resolve();
      yield* ctx.waitForSignal('release-recovery-control');
      return {
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: olderRunId,
        steps: 1,
        content: 'resumed',
        finishReason: 'stop-condition' as const,
      };
    });

    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);
    await store.save(
      createAgentSession({
        agentName: 'agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [
          {
            runId: olderRunId,
            sequence: 0,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: '',
          },
          {
            runId: newerRunId,
            sequence: 1,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: '',
          },
        ],
      }),
    );

    // Only the OLDER run is actually started durably and parked.
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: parkedWorkflow,
      recover: false,
      startScheduler: false,
    });
    const firstHandle = await engine1.start('agentRun', {}, { id: olderRunId });
    await enteredWorkflow.promise;
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    const kv2 = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store2 = createSessionStore(kv2);
    const cs2 = createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: parkedWorkflow,
      recover: false,
      startScheduler: false,
    });

    try {
      await engine2.recoverAll();

      const emitter = new TypedEventTarget<OperativeEventMap>();
      const recoverEvents: SessionRecoverEvent[] = [];
      emitter.addEventListener('session.recover', (e) => {
        recoverEvents.push(e);
      });

      const h = createSessionHandle(sessionId, {
        store: store2,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: cs2,
        emitter,
        runOptions: createTestRunOptions(),
      });

      const reattached = await h.recover();

      // The newer ref's rejection doesn't prevent falling through to the
      // older, resumable ref.
      expect(reattached).not.toBeNull();

      expect(recoverEvents).toHaveLength(1);
      expect(recoverEvents[0]!.runId).toBe(olderRunId);
      // The newer ref's rejection is still reported, not silently dropped.
      expect(recoverEvents[0]!.failures).toHaveLength(1);
      expect(recoverEvents[0]!.failures[0]!.runId).toBe(newerRunId);

      await engine2.signal(olderRunId, 'release-recovery-control', { released: true });
      await reattached!.result();
    } finally {
      engine2[Symbol.dispose]();
    }
  });

  it('returns null (gracefully) when engine.resume() throws for an unknown run', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);

    // Pre-seed a session with a 'running' run that has NO corresponding workflow
    // in the engine (simulate a run that was never actually started durably).
    const sessionId = 'd2-unknown-run-session';
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId: `${sessionId}:0`,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      const h = createSessionHandle(sessionId, {
        store,
        agentName: 'agent',
        engine,
        checkpointStore,
        runOptions: createTestRunOptions(),
      });

      // engine.resume() will throw because no workflow with that id exists.
      // recover() must return null rather than propagating the error.
      const reattached = await h.recover();
      expect(reattached).toBeNull();

      // AB-28: an unknown runId must NOT be reconciled to a terminal status —
      // engine.get() also returns null for it, so the RunRef is left exactly
      // as it was.
      const persisted = await store.load(sessionId);
      expect(persisted?.runs[0]?.status).toBe('running');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // AB-29: a failed durable re-attach must be observable through the
  // handle's emitter, distinguishable from the benign "nothing to resume"
  // outcome, without reading the durable store.
  const fakeCheckpointStore = createCheckpointStoreFixture(async (_runId: string) => ({
    conversation: null,
    cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
    steps: [],
  }));

  it('reports a rejected engine.resume() as an observable failure, and recover() still returns null', async () => {
    const sessionId = 'ab29-failed-reattach';
    const runId = `${sessionId}:0`;
    const resumeError = new Error('resolveWorkflowServices returned an unusable shape');

    const fakeEngine = createSessionEngine({
      resume: async (_workflowId: string) => {
        throw resumeError;
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    await store.save(
      createAgentSession({
        agentName: 'agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [
          {
            runId,
            sequence: 0,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: '',
          },
        ],
      }),
    );

    const emitter = new TypedEventTarget<OperativeEventMap>();
    const recoverEvents: SessionRecoverEvent[] = [];
    emitter.addEventListener('session.recover', (e) => {
      recoverEvents.push(e);
    });

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const reattached = await h.recover();

    // recover() keeps its documented disconnect-is-not-an-error contract.
    expect(reattached).toBeNull();

    // The failure is observable from the emitter alone, with the runId and
    // underlying error attached — no durable-store read required.
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0]!.sessionId).toBe(sessionId);
    expect(recoverEvents[0]!.runId).toBeNull();
    expect(recoverEvents[0]!.failures).toHaveLength(1);
    expect(recoverEvents[0]!.failures[0]!.runId).toBe(runId);
    expect(recoverEvents[0]!.failures[0]!.error).toBe(resumeError);
  });
});
