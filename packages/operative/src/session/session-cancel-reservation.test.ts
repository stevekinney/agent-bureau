import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
  fixtureRuntime,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

function createBlockingGenerate() {
  let abortCalled = false;
  let resolveGenerate: (() => void) | undefined;
  let signalGenerateStarted!: () => void;
  const generateStarted = new Promise<void>((resolve) => {
    signalGenerateStarted = resolve;
  });
  const generate: GenerateFunction = (_ctx) =>
    new Promise<{ content: string; toolCalls: [] }>((resolve) => {
      resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
      _ctx.signal?.addEventListener('abort', () => {
        abortCalled = true;
      });
      signalGenerateStarted();
    });
  return {
    abortCalled: () => abortCalled,
    generate,
    generateStarted,
    resolveGenerate: () => resolveGenerate?.(),
  };
}

describe('session.cancel() — durable cancellation', () => {
  it('aborts the current run and clears the in-flight reference', async () => {
    const blocking = createBlockingGenerate();

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('cancel-session', {
      store,
      agentName: 'cancel-agent',
      runOptions: {
        generate: blocking.generate,
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    const agentRun = h.run('please stop me');

    // Wait until the generate function is actually being called (which happens
    // after the session is loaded asynchronously). Only then is the abort
    // listener attached and cancel() will reliably trigger it.
    await blocking.generateStarted;

    expect(await h.recover()).not.toBeNull();
    await h.cancel();

    // The abort signal should have fired.
    expect(blocking.abortCalled()).toBe(true);
    // The handle should be cleared.
    expect(await h.recover()).toBeNull();

    // Allow the run to finish so we don't leave dangling promises.
    blocking.resolveGenerate();
    expect(agentRun.result()).resolves.toMatchObject({ finishReason: 'aborted' });

    const persisted = await store.load('cancel-session');
    const persistedRun = persisted!.runs[0]!;
    expect(persistedRun.status).toBe('aborted');
    expect(persistedRun.outcome).toMatchObject({
      finishReason: 'aborted',
      error: { kind: 'abort', code: 'ABORTED' },
    });
    expect(persistedRun.userMessageId).toBeDefined();
    expect(persistedRun.userMessageId).toBe(
      persisted!.conversationHistory.ids.find(
        (id) => persisted!.conversationHistory.messages[id]?.role === 'user',
      ),
    );
    expect(persisted!.conversationHistory.messages[persistedRun.userMessageId!]?.content).toBe(
      'please stop me',
    );
  });

  it('is a no-op when no run is in flight', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.cancel();
    expect(result).toBeUndefined();
  });

  it('cancels the Weft workflow when an engine is present', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = createSessionEngine({
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      get: async (id: string) => ({ id, status: 'cancelled' }),
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    // Pre-load a session with a running run.
    const runningSession = createAgentSession({
      agentName: 'durable-agent',
      conversationHistory: createConversationHistory(),
      id: 'durable-session',
      runs: [
        {
          runId: 'durable-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(runningSession);

    const h = createSessionHandle('durable-session', {
      store,
      agentName: 'durable-agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
      },
    });

    await h.cancel();

    expect(cancelledIds).toContain('durable-session:0');

    // Verify the session's run status was updated to 'aborted'.
    const updated = await store.load('durable-session');
    expect(updated!.runs[0]!.status).toBe('aborted');
  });

  it('reconciles a detached durable cancellation from engine outcome and checkpoint history', async () => {
    const sessionId = 'detached-cancel-reconcile-session';
    const runId = `${sessionId}:0`;
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(
      createAgentSession({
        agentName: 'durable-agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [
          {
            runId,
            sequence: 0,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: 'durable-agent',
            userMessageId: 'checkpoint-user-message',
          },
        ],
      }),
    );

    const checkpointConversation = new Conversation(createConversationHistory());
    checkpointConversation.appendUserMessage('from checkpoint');
    checkpointConversation.appendAssistantMessage('checkpoint answer');
    const engine = createSessionEngine({
      cancel: async () => {},
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId: id,
          steps: 2,
          content: 'checkpoint answer',
          finishReason: 'stop-condition',
        },
      }),
    });
    const checkpointStore = createCheckpointStoreFixture(async () => ({
      conversation: checkpointConversation.snapshot(),
      cursor: { totalUsage: {}, lastContent: 'checkpoint answer', schemaAttempts: 0 },
      steps: [],
    }));
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'durable-agent',
      engine,
      checkpointStore,
      runOptions: createTestRunOptions(),
    });

    await handle.cancel();

    const persisted = await store.load(sessionId);
    const run = persisted?.runs[0];
    expect(run?.status).toBe('completed');
    expect(run?.outcome).toEqual({ finishReason: 'stop-condition' });
    expect(run?.userMessageId).toBe('checkpoint-user-message');
    const contents = Object.values(persisted?.conversationHistory.messages ?? {}).map(
      (message) => message.content,
    );
    expect(contents).toContain('from checkpoint');
    expect(contents).toContain('checkpoint answer');
  });
});
