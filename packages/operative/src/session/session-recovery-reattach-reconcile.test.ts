import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('recover() — concurrent terminal reconciliation', () => {
  it('rejects recovered completion when the session disappears before commit', async () => {
    const sessionId = 'recovery-disappeared-session';
    const runId = `${sessionId}:0`;
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    await baseStore.save(
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
            userMessageId: 'originating-user-message',
          },
        ],
      }),
    );
    const store: SessionStore = {
      ...baseStore,
      async update() {
        return undefined;
      },
    };
    const fakeEngine = createSessionEngine({
      resume: async () => ({
        id: runId,
        result: async () => ({
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: 1,
          content: 'done',
          finishReason: 'stop-condition',
        }),
      }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));

    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });
    const recovered = await handle.recover();
    expect(recovered).not.toBeNull();
    expect(recovered!.result()).rejects.toThrow('disappeared');
  });

  it('does not recreate a recovered RunRef removed by a concurrent terminal update', async () => {
    const sessionId = 'recovery-run-ref-removed-session';
    const runId = `${sessionId}:0`;
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    await baseStore.save(
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
    const store: SessionStore = {
      ...baseStore,
      async update(id, mutate) {
        const current = await baseStore.load(id);
        if (!current) return undefined;
        const removed = { ...current, runs: [] };
        await baseStore.save(removed);
        return mutate(removed);
      },
    };
    const fakeEngine = createSessionEngine({
      resume: async () => ({
        id: runId,
        result: async () => ({
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: 1,
          content: 'done',
          finishReason: 'stop-condition',
        }),
      }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    const recovered = await handle.recover();
    expect(recovered).not.toBeNull();
    expect(recovered!.result()).rejects.toThrow('disappeared');
    const persisted = await baseStore.load(sessionId);
    expect(persisted?.runs).toHaveLength(0);
  });
});
