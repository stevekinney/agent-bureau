import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ConversationHistory, ConversationSnapshot } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { createSessionStore } from './create-session-store';
import { reconstructRunConversation } from './run-conversation-boundary';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle, ForkThroughRunError } from './session-handle';
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

const COMPLETED_RESULT = {
  schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  steps: 1,
  content: 'checkpoint answer',
  finishReason: 'stop-condition',
} as const;

function contents(history: ConversationHistory | undefined): unknown[] {
  return (history?.ids ?? []).map((id) => history?.messages[id]?.content);
}

function checkpointTranscript(): ConversationSnapshot {
  const conversation = new Conversation(createConversationHistory());
  conversation.appendUserMessage('from checkpoint');
  conversation.appendAssistantMessage('checkpoint answer');
  return conversation.snapshot();
}

function checkpointStoreWith(conversation: ConversationSnapshot | null) {
  return createCheckpointStoreFixture(async () => ({
    conversation,
    cursor: { totalUsage: {}, lastContent: 'checkpoint answer', schemaAttempts: 0 },
    steps: [],
  }));
}

async function seedRunningRun(sessionId: string): Promise<SessionStore> {
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  await store.save(
    createAgentSession({
      agentName: 'durable-agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId: `${sessionId}:0`,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: 'durable-agent',
        },
      ],
    }),
  );
  return store;
}

async function forkRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('terminal conversation boundaries on durable and failure paths', () => {
  it('records the seeded turn as the boundary when the engine rejects the run', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('boundary-engine-rejection', {
      store,
      agentName: 'durable-agent',
      engine: createSessionEngine({
        start: async (_type: string, _input: unknown, options: { id: string }) => ({
          id: options.id,
          result: () => Promise.reject(new Error('engine infrastructure failure')),
        }),
      }),
      checkpointStore: checkpointStoreWith(null),
      runOptions: createTestRunOptions(),
    });

    await handle
      .run('durable please')
      .result()
      .catch(() => {});
    await yieldToPortableEventLoop();

    const session = await store.load('boundary-engine-rejection');
    const runRef = session?.runs[0];
    expect(runRef?.status).toBe('error');
    const boundary = reconstructRunConversation(session!.runs, 0);
    expect(contents(boundary)).toEqual(['durable please']);
    const forked = await handle.fork({ throughRun: 0 });
    const forkedSession = await forked.getSession();
    expect(forkedSession.conversationHistory).toEqual(boundary!);
  });

  it('records a recovered run checkpoint transcript as its boundary', async () => {
    const sessionId = 'boundary-recovered-run';
    const store = await seedRunningRun(sessionId);
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'durable-agent',
      engine: createSessionEngine({
        resume: async (id: string) => ({
          id,
          result: async () => ({ ...COMPLETED_RESULT, runId: id }),
        }),
      }),
      checkpointStore: checkpointStoreWith(checkpointTranscript()),
      runOptions: createTestRunOptions(),
    });

    const recovered = await handle.recover();
    await recovered!.result();

    const session = await store.load(sessionId);
    const runRef = session?.runs[0];
    expect(runRef?.status).toBe('completed');
    const boundary = reconstructRunConversation(session!.runs, 0);
    expect(contents(boundary)).toEqual(['from checkpoint', 'checkpoint answer']);
    const forked = await handle.fork({ throughRun: 0 });
    const forkedSession = await forked.getSession();
    expect(forkedSession.conversationHistory).toEqual(boundary!);
  });

  it('records no boundary for a recovered run that rejected, so it cannot be forked through', async () => {
    const sessionId = 'boundary-recovered-rejection';
    const store = await seedRunningRun(sessionId);
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'durable-agent',
      engine: createSessionEngine({
        resume: async (id: string) => ({
          id,
          result: async () => {
            throw new UnsupportedRunResultVersionError(999);
          },
        }),
      }),
      checkpointStore: checkpointStoreWith(checkpointTranscript()),
      runOptions: createTestRunOptions(),
    });

    const recovered = await handle.recover();
    await recovered!.result().catch(() => {});

    const session = await store.load(sessionId);
    const runRef = session?.runs[0];
    expect(runRef?.status).toBe('error');
    expect(runRef?.conversationBoundary).toBeUndefined();
    expect(await forkRejection(handle.fork({ throughRun: 0 }))).toMatchObject({
      reason: 'unavailable',
    });
  });

  it.each([
    ['with', checkpointTranscript(), ['from checkpoint', 'checkpoint answer']],
    ['without', null, undefined],
  ] as const)(
    'reconciles a detached terminal run %s a checkpoint transcript',
    async (_label, checkpointConversation, expectedContents) => {
      const sessionId = `boundary-reconciled-${_label}`;
      const store = await seedRunningRun(sessionId);
      const handle = createSessionHandle(sessionId, {
        store,
        agentName: 'durable-agent',
        engine: createSessionEngine({
          cancel: async () => {},
          get: async (id: string) => ({
            id,
            status: 'completed',
            result: { ...COMPLETED_RESULT, runId: id },
          }),
        }),
        checkpointStore: checkpointStoreWith(checkpointConversation),
        runOptions: createTestRunOptions(),
      });

      await handle.cancel();

      const session = await store.load(sessionId);
      const runRef = session?.runs[0];
      expect(runRef?.status).toBe('completed');
      const rejection = await forkRejection(handle.fork({ throughRun: 0 }));
      if (expectedContents === undefined) {
        expect(runRef?.conversationBoundary).toBeUndefined();
        expect(rejection).toBeInstanceOf(ForkThroughRunError);
        expect(rejection).toMatchObject({ reason: 'unavailable' });
      } else {
        const boundary = reconstructRunConversation(session!.runs, 0);
        expect(contents(boundary)).toEqual([...expectedContents]);
        expect(rejection).toBeUndefined();
      }
    },
  );
});
