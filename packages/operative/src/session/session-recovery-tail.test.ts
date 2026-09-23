import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  alreadyTerminalError,
  createCheckpointStoreFixture,
  createTestRunOptions,
  seedRunningSession,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — terminal idempotence and engine errors', () => {
  it('leaves the RunRef untouched when engine.get() reports it as still non-terminal', async () => {
    // A defensive case: engine.resume() rejected for some other reason (a
    // transient error, a race), but engine.get() says the workflow is still
    // suspended/running/pending. resume() should have succeeded for a
    // genuinely non-terminal workflow, so reconciliation must not guess at a
    // status here — it leaves the RunRef alone.
    const sessionId = 'ab-28-still-suspended-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw new Error('transient resume failure');
      },
      get: async (id: string) => ({ id, status: 'suspended' }),
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
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('running');
  });

  it('leaves the RunRef untouched when engine.get() itself throws', async () => {
    const sessionId = 'ab-28-get-throws-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async () => {
        throw new Error('storage unavailable');
      },
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
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('running');
  });

  it('is idempotent: calling recover() twice on a reconciled session appends no runs and does not duplicate messages', async () => {
    const sessionId = 'ab-28-idempotent-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const recoveredConversation = new Conversation(createConversationHistory());
    recoveredConversation.appendUserMessage('once');

    let getCalls = 0;
    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => {
        getCalls += 1;
        return {
          id,
          status: 'completed',
          result: {
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: id,
            steps: 1,
            content: 'once',
            finishReason: 'stop-condition',
          },
        };
      },
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_id: string) => ({
      conversation: recoveredConversation.snapshot(),
      cursor: { totalUsage: {}, lastContent: 'once', schemaAttempts: 0 },
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
    const afterFirst = await store.load(sessionId);
    expect(afterFirst?.runs).toHaveLength(1);
    expect(afterFirst?.runs[0]?.status).toBe('completed');

    // A second call must not find a 'running' ref to reconcile at all — the
    // first call's write already flipped it to 'completed'.
    expect(await h.recover()).toBeNull();
    const afterSecond = await store.load(sessionId);

    expect(afterSecond?.runs).toEqual(afterFirst?.runs);
    expect(afterSecond?.conversationHistory).toEqual(afterFirst?.conversationHistory);
    // Only the first call's fallback loop ever called engine.get() for this
    // run — the second call's session load shows no running ref to retry.
    expect(getCalls).toBe(1);
  });

  // AB-330: "reconciles the RunRef against a REAL Weft engine..." moved to
  // `session-handle-real-engine-recovery.test.ts` — it drives a real
  // background scheduler poller and a real per-iteration setTimeout poll,
  // which createRunEngine has no clock-injection seam for.
});
