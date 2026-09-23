import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { GuardrailTripwireError } from '../errors';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import {
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.run() — persistence and history', () => {
  it('appends a RunRef to the session when the run completes', async () => {
    const { handle, store } = createSessionHandleFixture();

    const run = handle.run('say something');
    const result = await run.result();

    // Give the persistence callback a tick to run.
    await yieldToPortableEventLoop();

    const session = await store.load(handle.id);
    expect(session).toBeDefined();
    expect(session!.runs).toHaveLength(1);
    expect(session!.runs[0]!.sequence).toBe(0);
    expect(session!.runs[0]!.runId).toBe(`${handle.id}:0`);
    expect(session!.runs[0]!.status).toBe('completed');
    expect(result.finishReason).toBe('maximum-steps');
  });

  it('persists the exact user message id and safe terminal outcome on the run reference', async () => {
    const { handle, store } = createSessionHandleFixture();

    const result = await handle.run('first prompt').result();
    const session = await store.load(handle.id);
    const run = session?.runs[0];

    expect(run?.userMessageId).toBeString();
    expect(session?.conversationHistory.messages[run!.userMessageId!]?.role).toBe('user');
    expect(run?.outcome?.finishReason).toBe(result.finishReason);
  });

  it('associates each run with its own appended user message after history exists', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('first prompt').result();
    await handle.run('second prompt').result();

    const session = await store.load(handle.id);
    const secondRun = session?.runs[1];
    expect(secondRun?.userMessageId).toBeString();
    expect(session?.conversationHistory.messages[secondRun!.userMessageId!]).toMatchObject({
      role: 'user',
      content: 'second prompt',
    });
  });

  it('holds terminal run events until the terminal session write commits', async () => {
    const { handle: baseHandle, store: baseStore } = createSessionHandleFixture();
    let release!: () => void;
    const terminalCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedStore: SessionStore = {
      ...baseStore,
      async update(...args) {
        const updated = await baseStore.update(...args);
        if (updated?.runs.at(-1)?.status !== 'running') await terminalCommit;
        return updated;
      },
    };
    const handle = createSessionHandle(baseHandle.id, {
      store: delayedStore,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
    });
    const run = handle.run('commit barrier');
    const events: string[] = [];
    const consuming = (async () => {
      for await (const event of run) events.push(event.type);
    })();
    await yieldToPortableEventLoop();
    await yieldToPortableEventLoop();
    expect(events).not.toContain('run.completed');
    release();
    await run.result();
    await consuming;
    expect(events).toContain('run.completed');
  });

  it.each([false, true])(
    'holds terminal tripwire events through session commit (failure=%s)',
    async (failCommit) => {
      const store = createSessionStore(textValueStore(new MemoryStorage()));
      const enteredCommit = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const persistenceFailure = new Error('commit failed');
      let updates = 0;
      const delayedStore: SessionStore = {
        ...store,
        async update(...args) {
          if (++updates === 2) {
            enteredCommit.resolve();
            await releaseCommit.promise;
            if (failCommit) throw persistenceFailure;
          }
          return store.update(...args);
        },
      };
      const handle = createSessionHandle('tripwire-commit', {
        store: delayedStore,
        agentName: 'agent',
        runOptions: createTestRunOptions(async () => {
          throw new GuardrailTripwireError('guardrail blocked', {
            guardrailName: 'test',
            category: 'test',
            phase: 'input',
            confidence: 1,
          });
        }),
      });
      const run = handle.run('commit barrier');
      const result = run.result();
      void result.catch(() => undefined);
      const events: string[] = [];
      const consuming = (async () => {
        for await (const event of run) events.push(event.type);
      })();
      await enteredCommit.promise;
      await yieldToPortableEventLoop();
      expect(events).not.toContain('run.tripwire');
      expect(events).not.toContain('run.completed');
      releaseCommit.resolve();
      if (failCommit) {
        expect(result).rejects.toBe(persistenceFailure);
      } else {
        expect(result).resolves.toMatchObject({ finishReason: 'tripwire' });
      }
      await consuming;
      expect(events.filter((type) => type === 'run.tripwire')).toHaveLength(failCommit ? 0 : 1);
      expect(events.filter((type) => type === 'run.completed')).toHaveLength(failCommit ? 0 : 1);
    },
  );

  it('F2: RunRef.agentName carries the name of the agent that ran the run', async () => {
    // The fixture uses 'test-agent' as the agentName for the session handle.
    const { handle, store } = createSessionHandleFixture();

    await handle.run('say something').result();

    // Give the persistence callback a tick to run.
    await yieldToPortableEventLoop();

    const session = await store.load(handle.id);
    expect(session!.runs[0]!.agentName).toBe('test-agent');
  });

  it('accumulates multiple runs in sequence', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('first').result();
    // Flush persistence callbacks.
    await yieldToPortableEventLoop();
    await handle.run('second').result();
    await yieldToPortableEventLoop();

    const session = await store.load(handle.id);
    expect(session!.runs).toHaveLength(2);
    expect(session!.runs[0]!.sequence).toBe(0);
    expect(session!.runs[1]!.sequence).toBe(1);
    expect(session!.runs[1]!.runId).toBe(`${handle.id}:1`);
  });

  it('concurrent handles reserve unique run sequences and preserve both conversations', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const firstHandle = createSessionHandle('concurrent-run-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(createInstantGenerate('first reply')),
    });
    const secondHandle = createSessionHandle('concurrent-run-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(createInstantGenerate('second reply')),
    });

    await Promise.all([
      firstHandle.run('first concurrent message').result(),
      secondHandle.run('second concurrent message').result(),
    ]);
    await yieldToPortableEventLoop();

    const session = await store.load('concurrent-run-session');
    expect(session).toBeDefined();
    expect(session!.runs).toHaveLength(2);
    expect(session!.runs.map((run) => run.sequence).toSorted((a, b) => a - b)).toEqual([0, 1]);
    expect(new Set(session!.runs.map((run) => run.runId)).size).toBe(2);

    const contents = session!.conversationHistory.ids.map(
      (id) => session!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('first concurrent message');
    expect(contents).toContain('second concurrent message');
  });

  it('preserves message edits from one concurrent run without dropping another run', async () => {
    const sessionId = 'concurrent-redaction-session';
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const baseConversation = new Conversation(createConversationHistory({ id: sessionId }));
    baseConversation.appendUserMessage('sensitive original');
    await store.save(
      createAgentSession({
        id: sessionId,
        agentName: 'test-agent',
        conversationHistory: baseConversation.current,
      }),
    );

    const redactingHandle = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(async (context) => {
        context.conversation.redactMessageAtPosition(0, 'redacted original');
        return { content: 'redacted reply', toolCalls: [] };
      }),
    });
    const appendingHandle = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(createInstantGenerate('appended reply')),
    });

    await Promise.all([
      redactingHandle.run('redact request').result(),
      appendingHandle.run('append request').result(),
    ]);
    await yieldToPortableEventLoop();

    const session = await store.load(sessionId);
    expect(session).toBeDefined();
    const contents = session!.conversationHistory.ids.map(
      (id) => session!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('redacted original');
    expect(contents).not.toContain('sensitive original');
    expect(contents).toContain('append request');
  });

  it('updates the session conversation history after each run', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('hello world').result();
    await yieldToPortableEventLoop();

    const session = await store.load(handle.id);
    // The conversation history should contain at least the user message.
    expect(session!.conversationHistory).toBeDefined();
  });

  // Regression: Finding PRRT_kwDORvupsc6MUE_y — run() always started from an
  // empty conversation, ignoring the stored conversationHistory. A second run
  // should see the messages accumulated by the first run.
  it('F1 regression: second run seeds conversation from first run history', async () => {
    // Capture the message-id count the generate function sees on each call.
    const historyLengths: number[] = [];

    const capturingGenerate: GenerateFunction = async (ctx) => {
      historyLengths.push(ctx.conversation.current.ids.length);
      return { content: 'reply', toolCalls: [] };
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('f1-regression-session', {
      store,
      agentName: 'f1-agent',
      runOptions: {
        generate: capturingGenerate,
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    // First run: generate sees only the initial user message.
    await h.run('first message').result();
    await yieldToPortableEventLoop();

    // Second run: generate must see the first run's messages PLUS the new one.
    await h.run('second message').result();
    await yieldToPortableEventLoop();

    // First call: 1 user message seeded.
    expect(historyLengths[0]).toBeGreaterThanOrEqual(1);
    // Second call: should see MORE messages than the first call (history carried
    // forward). Before the fix, this was also 1 (empty history each time).
    expect(historyLengths[1]).toBeGreaterThan(historyLengths[0]!);
  });

  // Regression: Finding PRRT_kwDORvupsc6MV8XO — run() only persisted a RunRef
  // after the run completed, so signal()/update()/recover() could not find a
  // running run in the store while the workflow was still in-flight (HITL, parked
  // durable runs). After the fix, a 'running' RunRef is persisted BEFORE the
  // inner run starts, and replaced with the terminal status on completion.
});
