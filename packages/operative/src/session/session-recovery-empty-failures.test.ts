import { TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { OperativeEventMap, SessionRecoverEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import { createCheckpointStoreFixture, createTestRunOptions } from './session-handle-test-support';

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

describe('recover() — empty failure reporting', () => {
  it('distinguishes "nothing to resume" from a failed reattach via an empty failures array', async () => {
    const sessionId = 'ab29-nothing-to-resume';

    const fakeEngine = createSessionEngine({
      resume: async (_workflowId: string) => {
        throw new Error('should never be called: there is no running ref');
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    // No runs at all — the benign "no in-flight run" case.
    await store.save(
      createAgentSession({
        agentName: 'agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [],
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
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0]!.runId).toBeNull();
    // Distinguishable from the failure case: no attempt was made, so no
    // failures were recorded.
    expect(recoverEvents[0]!.failures).toHaveLength(0);
  });
});
