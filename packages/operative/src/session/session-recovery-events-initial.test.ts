import { TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
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
  makeParkingWorkflow,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — successful reattach events', () => {
  it('emits SessionRecoverEvent with the runId on a successful durable reattach', async () => {
    const storage = new MemoryStorage();
    const sessionId = 'd2-event-session';
    const runId = `${sessionId}:0`;
    const SLEEP_MS = 50;

    // Pre-seed the session as 'running' in the store.
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);
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
    await store.save(session);

    // Start the first engine + park a run.
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });
    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    for (let i = 0; i < 10; i++) await yieldToPortableEventLoop();
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    // Restart: second engine, recover, build the session handle.
    const kv2 = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store2 = createSessionStore(kv2);
    const cs2 = createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: true,
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
      expect(reattached).not.toBeNull();

      // The event carries the actual runId, not null.
      expect(recoverEvents).toHaveLength(1);
      expect(recoverEvents[0]!.sessionId).toBe(sessionId);
      expect(recoverEvents[0]!.runId).toBe(runId);
      // AB-29: the successful re-attach path reports no failures.
      expect(recoverEvents[0]!.failures).toHaveLength(0);

      // Let the recovered run finish so no dangling promises.
      await reattached!.result();
    } finally {
      engine2[Symbol.dispose]();
    }
  });

  it.each([
    { failCommit: false, tripwire: false },
    { failCommit: true, tripwire: false },
    { failCommit: false, tripwire: true },
    { failCommit: true, tripwire: true },
  ])(
    'holds recovered cleanup and events through terminal commit (case=%j)',
    async ({ failCommit, tripwire }) => {
      const sessionId = 'recovered-event-commit-barrier-session';
      const runId = `${sessionId}:0`;
      const store = createSessionStore(textValueStore(new MemoryStorage()));
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
              agentName: 'agent',
            },
          ],
        }),
      );

      const terminalCommit = Promise.withResolvers<void>();
      const commitStarted = Promise.withResolvers<void>();
      const commitFailure = new Error('terminal store failed');
      const delayedStore: SessionStore = {
        ...store,
        async update(...args) {
          commitStarted.resolve();
          await terminalCommit.promise;
          if (failCommit) throw commitFailure;
          return store.update(...args);
        },
      };
      const resultReady = Promise.withResolvers<void>();
      const engine = createSessionEngine({
        resume: async () => ({
          id: runId,
          result: async () => {
            resultReady.resolve();
            return {
              schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
              runId,
              steps: 1,
              content: 'recovered answer',
              finishReason: tripwire ? 'tripwire' : 'stop-condition',
              ...(tripwire
                ? {
                    tripwire: {
                      guardrailName: 'test',
                      category: 'test',
                      phase: 'input',
                      confidence: 1,
                    },
                    errorMessage: 'guardrail blocked',
                    errorKind: 'policy',
                    errorCode: 'TRIPWIRE',
                  }
                : {}),
            };
          },
        }),
      });
      const checkpointStore = createCheckpointStoreFixture(async () => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: 'recovered answer', schemaAttempts: 0 },
        steps: [],
      }));
      const handle = createSessionHandle(sessionId, {
        store: delayedStore,
        agentName: 'agent',
        engine,
        checkpointStore,
        runOptions: createTestRunOptions(),
      });

      const recovered = await handle.recover();
      expect(recovered).not.toBeNull();
      let cleanupSettled = false;
      const closed = recovered!.closed().then((acknowledgement) => {
        cleanupSettled = true;
        return acknowledgement;
      });
      const result = recovered!.result();
      void result.catch(() => undefined);
      const events: string[] = [];
      const consuming = (async () => {
        for await (const event of recovered!) events.push(event.type);
      })();
      await resultReady.promise;
      await commitStarted.promise;
      await yieldToPortableEventLoop();
      expect(events).not.toContain('run.completed');
      expect(events).not.toContain('run.tripwire');
      expect(cleanupSettled).toBe(false);
      expect(await handle.recover()).toBe(recovered);
      const sessionClosed = handle.closed();
      const pendingSession = await store.load(sessionId);
      expect(pendingSession?.runs[0]?.status).toBe('running');

      terminalCommit.resolve();
      if (failCommit) {
        expect(result).rejects.toBe(commitFailure);
        expect(await closed).toEqual({ status: 'failed', error: commitFailure });
        expect(events).not.toContain('run.completed');
      } else {
        await result;
        const acknowledgement = await closed;
        const committedSession = await store.load(sessionId);
        expect(acknowledgement.status).not.toBe('failed');
        expect(committedSession?.runs[0]?.status).toBe(tripwire ? 'error' : 'completed');
        expect(events).toContain('run.completed');
      }
      await consuming;
      expect(events.filter((type) => type === 'run.tripwire')).toHaveLength(
        tripwire && !failCommit ? 1 : 0,
      );
      expect(await recovered!.closed()).toBe(await closed);
      expect(await sessionClosed).toBe(await closed);
    },
  );
});
