import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { UnsupportedRunResultVersionError } from '../run-envelope';
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

describe('recover() — reattach failure and initial state', () => {
  it('persists a safe error outcome when the recovered result rejects', async () => {
    const sessionId = 'recovery-result-rejection-session';
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
            userMessageId: 'originating-user-message',
          },
        ],
      }),
    );
    const fakeEngine = createSessionEngine({
      resume: async () => ({
        id: runId,
        result: async () => {
          throw new UnsupportedRunResultVersionError(999);
        },
      }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
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
    expect(recovered!.result()).rejects.toBeInstanceOf(UnsupportedRunResultVersionError);

    const persisted = await store.load(sessionId);
    const run = persisted?.runs[0];
    expect(run?.status).toBe('error');
    expect(run?.userMessageId).toBe('originating-user-message');
    expect(run?.outcome).toEqual({ finishReason: 'error' });
    expect(JSON.stringify(run?.outcome)).not.toContain('UnsupportedRunResultVersionError');
  });

  it('rejects recovered completion when a concurrent terminal classification wins', async () => {
    const sessionId = 'recovery-terminal-conflict-session';
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
      async update(id, mutate) {
        const current = await baseStore.load(id);
        if (!current) return undefined;
        const concurrent = {
          ...current,
          runs: current.runs.map((run) =>
            run.runId === runId
              ? {
                  ...run,
                  status: 'aborted' as const,
                  outcome: { finishReason: 'aborted' as const },
                }
              : run,
          ),
        };
        await baseStore.save(concurrent);
        return mutate(concurrent);
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
    expect(recovered!.result()).rejects.toThrow('conflicting terminal');
    const conflictedSession = await baseStore.load(sessionId);
    expect(conflictedSession?.runs[0]?.status).toBe('aborted');
  });

  it.each(['terminal', 'recorded-base', 'legacy'])(
    'accepts an already committed matching terminal classification (%s)',
    async (mode) => {
      const sessionId = 'recovery-terminal-idempotent-session';
      const runId = `${sessionId}:0`;
      const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
      const knownConversation = new Conversation(
        createConversationHistory({ metadata: { known: 'base', removed: true } }),
      );
      knownConversation.appendAssistantMessage('known answer');
      const knownMessageId = knownConversation.current.ids[0]!;
      const checkpointConversation = new Conversation({
        ...knownConversation.current,
        metadata: { known: 'run', checkpoint: true },
      });
      checkpointConversation.appendUserMessage('recovered user');
      checkpointConversation.appendAssistantMessage('recovered answer');
      const checkpointHistory = checkpointConversation.snapshot();
      expect(Conversation.from(checkpointHistory).current.ids).toEqual(
        checkpointConversation.current.ids,
      );
      const checkpointUserMessageId = checkpointConversation.current.ids.find(
        (id) => checkpointConversation.current.messages[id]?.role === 'user',
      );
      if (!checkpointUserMessageId) throw new Error('Expected checkpoint user message');
      await baseStore.save(
        createAgentSession({
          agentName: 'agent',
          conversationHistory: knownConversation.current,
          id: sessionId,
          runs: [
            {
              runId,
              sequence: 0,
              status: 'running',
              startedAt: fixtureRuntime.clock.nowISO(),
              agentName: 'agent',
              userMessageId: checkpointUserMessageId,
              ...(mode === 'legacy'
                ? {}
                : {
                    baseConversationMetadata: structuredClone(knownConversation.current.metadata),
                  }),
            },
          ],
        }),
      );
      const store: SessionStore = {
        ...baseStore,
        async update(id, mutate) {
          const current = await baseStore.load(id);
          if (!current) return undefined;
          const concurrentHistory = {
            ...current.conversationHistory,
            messages: {
              ...current.conversationHistory.messages,
              [knownMessageId]: {
                ...current.conversationHistory.messages[knownMessageId]!,
                content: 'updated known answer',
              },
            },
            metadata: { known: 'current', removed: true, concurrent: true },
          };
          const concurrent = {
            ...current,
            conversationHistory: concurrentHistory,
            runs: current.runs.map((run) =>
              run.runId === runId && mode === 'terminal'
                ? {
                    ...run,
                    status: 'completed' as const,
                    outcome: { finishReason: 'stop-condition' as const },
                  }
                : run,
            ),
          };
          await baseStore.save(concurrent);
          return baseStore.update(id, mutate);
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
        conversation: checkpointHistory,
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
      expect(recovered!.result()).resolves.toMatchObject({
        finishReason: 'stop-condition',
      });
      const closedAfterCommit = await recovered!.closed();
      expect(closedAfterCommit.status).not.toBe('failed');
      expect(await recovered!.closed()).toBe(closedAfterCommit);
      const persisted = await baseStore.load(sessionId);
      const messages = Object.values(persisted!.conversationHistory.messages);
      expect(persisted!.conversationHistory.messages[knownMessageId]?.content).toBe(
        'updated known answer',
      );
      expect(messages.filter((message) => message.content === 'known answer')).toHaveLength(0);
      expect(messages.filter((message) => message.content === 'recovered user')).toHaveLength(1);
      expect(messages.filter((message) => message.content === 'recovered answer')).toHaveLength(1);
      expect(persisted!.conversationHistory.metadata).toEqual(
        mode === 'terminal'
          ? { known: 'current', removed: true, concurrent: true }
          : mode === 'legacy'
            ? { known: 'current', removed: true, concurrent: true, checkpoint: true }
            : { known: 'run', concurrent: true, checkpoint: true },
      );
      expect(persisted!.runs[0]!.outcome).toEqual({ finishReason: 'stop-condition' });
    },
  );
});
