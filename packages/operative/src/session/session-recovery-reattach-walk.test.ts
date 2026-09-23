import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import { createRunEngine } from '../durable/create-run-engine';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
  makeParkingWorkflow,
  makeProbeWorkflow,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — running reference selection', () => {
  it('returns null when engine is present but session has no running run', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);
    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      const h = createSessionHandle('no-running-run-session', {
        store,
        agentName: 'agent',
        engine,
        checkpointStore,
        runOptions: createTestRunOptions(),
      });

      // No runs at all — recover() returns null.
      expect(await h.recover()).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('returns null when engine is present but no run is running', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);
    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      // Pre-load a session with a completed run.
      const session = createAgentSession({
        agentName: 'agent',
        conversationHistory: createConversationHistory(),
        id: 'completed-run-session',
        runs: [
          {
            runId: 'completed-run-session:0',
            sequence: 0,
            status: 'completed',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: '',
          },
        ],
      });
      await store.save(session);

      const h = createSessionHandle('completed-run-session', {
        store,
        agentName: 'agent',
        engine,
        checkpointStore,
        runOptions: createTestRunOptions(),
      });

      expect(await h.recover()).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('reattaches to a running run even when a later run is terminal', async () => {
    const resumedIds: string[] = [];
    const fakeEngine = createSessionEngine({
      resume: async (id: string) => {
        resumedIds.push(id);
        return {
          id,
          result: () => new Promise<unknown>(() => {}),
        };
      },
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_runId: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'earlier-running-session',
      runs: [
        {
          runId: 'earlier-running-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
        {
          runId: 'earlier-running-session:1',
          sequence: 1,
          status: 'completed',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('earlier-running-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    const recovered = await h.recover();

    expect(recovered).not.toBeNull();
    expect(resumedIds).toEqual(['earlier-running-session:0']);
  });

  it('tries older running refs when the newest running ref cannot resume', async () => {
    const resumedIds: string[] = [];
    const fakeEngine = createSessionEngine({
      resume: async (id: string) => {
        resumedIds.push(id);
        if (id === 'fallback-running-session:1') {
          throw new Error('stale workflow');
        }
        return {
          id,
          result: () => new Promise<unknown>(() => {}),
        };
      },
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_runId: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'fallback-running-session',
      runs: [
        {
          runId: 'fallback-running-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
        {
          runId: 'fallback-running-session:1',
          sequence: 1,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('fallback-running-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    const recovered = await h.recover();

    expect(recovered).not.toBeNull();
    expect(resumedIds).toEqual(['fallback-running-session:1', 'fallback-running-session:0']);
  });

  it('reattaches to a recovered durable run after simulated restart (invariant #4)', async () => {
    // D2 ACCEPTANCE: crash → restart → same store → in-flight run auto-resumes.
    //
    // Step 1: Start an engine with a parking workflow and launch a run. The run
    //         parks on ctx.sleep. "Crash" by disposing the first engine without
    //         awaiting the run's result (the workflow stays in the store as
    //         in-progress).
    //
    // Step 2: Build a SECOND engine over the same storage with recover:false
    //         (we own recoverAll), call recoverAll(), then call
    //         session.recover() to prove it re-attaches to the resumed workflow.

    // Use a short sleep so the test does not wall-clock-wait.
    const SLEEP_MS = 50;
    const storage = new MemoryStorage();
    const sessionId = 'd2-recovery-session';
    const runId = `${sessionId}:0`;

    // --- First "process" ---
    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);

    const { engine: engine1, checkpointStore: cs1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false, // do NOT arm the poller; the run stays parked
    });

    // Persist the session with status 'running' (simulates what the session
    // handle does after run() starts).
    const session = createAgentSession({
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
    });
    await firstStore.save(session);
    // Suppress unused variable — cs1 is needed to satisfy the typed factory.
    void cs1;

    // Start the durable workflow under the run's id so recovery can find it.
    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    // Drain the inline launch so the run reaches ctx.sleep before disposal.
    for (let i = 0; i < 10; i++) {
      await yieldToPortableEventLoop();
    }
    // "Crash": dispose the first engine. The workflow stays in storage as
    // in-progress (parked on its sleep).
    engine1[Symbol.dispose]();
    // Silently swallow the EngineDisposedError so we don't leave an unhandled rejection.
    void firstHandle.result().catch(() => {});

    // --- Second "process" (restart) ---
    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );

    // recover:false so we call recoverAll() ourselves (the bureau owns recovery).
    // startScheduler:true so the parked ctx.sleep timer fires.
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: true,
    });

    try {
      // Boot recovery: resume in-flight workflows.
      const recoveredHandles = await engine2.recoverAll();
      expect(recoveredHandles.length).toBeGreaterThanOrEqual(1);

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      // D2 ACCEPTANCE: session.recover() re-attaches to the recovered workflow.
      const reattached = await h.recover();
      expect(reattached).not.toBeNull();

      // The reattached run settles when the parked ctx.sleep fires.
      const result = await reattached!.result();
      // finishReason proves the run completed (not errored, not aborted).
      expect(result.finishReason).toBe('stop-condition');

      // AB-28 acceptance: unchanged existing behavior for a run still in
      // flight at recover() time — the RunRef transitions to 'completed' on
      // settle (via the success branch's fire-and-forget write, so poll for
      // it rather than reading the store synchronously).
      let persistedStatus: string | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const persisted = await secondStore.load(sessionId);
        persistedStatus = persisted?.runs.find((r) => r.runId === runId)?.status;
        if (persistedStatus === 'completed') break;
        await yieldToPortableEventLoop();
      }
      expect(persistedStatus).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});
