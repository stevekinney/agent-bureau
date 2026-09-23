import { TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { OperativeEventMap, SessionRecoverEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

const fakeCheckpointStore = createCheckpointStoreFixture(async (_runId: string) => ({
  conversation: null,
  cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
  steps: [],
}));

describe('recover() — rejected run reporting', () => {
  it('reports every rejected runId when multiple running refs are walked', async () => {
    const sessionId = 'ab29-multiple-running-refs';
    const olderRunId = `${sessionId}:0`;
    const newerRunId = `${sessionId}:1`;
    const attemptedRunIds: string[] = [];

    const fakeEngine = createSessionEngine({
      resume: async (workflowId: string) => {
        attemptedRunIds.push(workflowId);
        throw new Error(`engine rejected resume for "${workflowId}"`);
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

    expect(reattached).toBeNull();
    // Walked newest-first, same order as the resume attempts.
    expect(attemptedRunIds).toEqual([newerRunId, olderRunId]);
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0]!.failures).toHaveLength(2);
    expect(recoverEvents[0]!.failures.map((f) => f.runId)).toEqual([newerRunId, olderRunId]);
  });
});
