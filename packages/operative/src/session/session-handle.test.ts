import { activity, workflow } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import type { Toolbox } from 'armorer';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';
import { z } from 'zod';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import type { AnyRunEngine } from '../durable/create-run-engine';
import { createRunEngine } from '../durable/create-run-engine';
import type {
  OperativeEventMap,
  SessionCancelEvent,
  SessionForkEvent,
  SessionMonitorDoneEvent,
  SessionMonitorTickEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import {
  createSessionHandle,
  deriveRunId,
  ForkThroughRunError,
  NoDurableEngineError,
  NoRunningRunError,
} from './session-handle';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * A synchronous mock generate function that immediately returns a single
 * completed response. Used in tests that need a session's `run()` to finish.
 */
function createInstantGenerate(content = 'hello'): GenerateFunction {
  return async () => ({
    content,
    toolCalls: [],
  });
}

/**
 * Base run options used across test fixtures. Sets `maximumSteps: 1` so
 * the instant generate finishes after a single step (avoids 25-step loops).
 */
function createTestRunOptions(generate: GenerateFunction = createInstantGenerate()) {
  return {
    generate,
    toolbox: createToolbox([]) as unknown as Toolbox,
    maximumSteps: 1,
  };
}

function createSessionHandleFixture(overrides?: { sessionId?: string; engine?: AnyRunEngine }) {
  const sessionId = overrides?.sessionId ?? 'test-session';
  const kv = textValueStore(new MemoryStorage());
  const store = createSessionStore(kv);

  return {
    sessionId,
    store,
    handle: createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      engine: overrides?.engine,
      runOptions: createTestRunOptions(),
    }),
  };
}

// ---------------------------------------------------------------------------
// deriveRunId
// ---------------------------------------------------------------------------

describe('deriveRunId', () => {
  it('produces sessionId:sequence format', () => {
    expect(deriveRunId('user-123', 0)).toBe('user-123:0');
    expect(deriveRunId('user-123', 5)).toBe('user-123:5');
  });

  it('is self-describing — session and sequence are both recoverable from the id', () => {
    const id = deriveRunId('my-session', 3);
    const [session, seq] = id.split(':');
    expect(session).toBe('my-session');
    expect(Number(seq)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createSessionHandle — basic structure
// ---------------------------------------------------------------------------

describe('createSessionHandle', () => {
  it('exposes the session id on the handle', () => {
    const { handle, sessionId } = createSessionHandleFixture();
    expect(handle.id).toBe(sessionId);
  });

  it('getSession() creates a new session when none exists', async () => {
    const { handle, sessionId } = createSessionHandleFixture();
    const session = await handle.getSession();
    expect(session.id).toBe(sessionId);
    expect(session.runs).toEqual([]);
  });

  it('getSession() loads an existing session', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const existing = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: createConversationHistory(),
      id: 'existing-session',
    });
    await store.save(existing);

    const handle = createSessionHandle('existing-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    const session = await handle.getSession();
    expect(session.id).toBe('existing-session');
  });
});

// ---------------------------------------------------------------------------
// run() — starts a run and updates session on completion
// ---------------------------------------------------------------------------

describe('session.run()', () => {
  it('returns an AgentRun handle immediately (synchronous)', () => {
    const { handle } = createSessionHandleFixture();
    const run = handle.run('hello');
    expect(run).toBeDefined();
    expect(typeof run.result).toBe('function'); // AgentRun.result() is a method
    expect(typeof run.abort).toBe('function');
    expect(typeof run[Symbol.asyncIterator]).toBe('function');
  });

  it('appends a RunRef to the session when the run completes', async () => {
    const { handle, store } = createSessionHandleFixture();

    const run = handle.run('say something');
    const result = await run.result();

    // Give the persistence callback a tick to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load(handle.id);
    expect(session).toBeDefined();
    expect(session!.runs).toHaveLength(1);
    expect(session!.runs[0]!.sequence).toBe(0);
    expect(session!.runs[0]!.runId).toBe(`${handle.id}:0`);
    expect(session!.runs[0]!.status).toBe('completed');
    expect(result.finishReason).toBe('maximum-steps');
  });

  it('F2: RunRef.agentName carries the name of the agent that ran the run', async () => {
    // The fixture uses 'test-agent' as the agentName for the session handle.
    const { handle, store } = createSessionHandleFixture();

    await handle.run('say something').result();

    // Give the persistence callback a tick to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load(handle.id);
    expect(session!.runs[0]!.agentName).toBe('test-agent');
  });

  it('accumulates multiple runs in sequence', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('first').result();
    // Flush persistence callbacks.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await handle.run('second').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

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
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load('concurrent-run-session');
    expect(session).toBeDefined();
    expect(session!.runs).toHaveLength(2);
    expect(session!.runs.map((run) => run.sequence).sort()).toEqual([0, 1]);
    expect(new Set(session!.runs.map((run) => run.runId)).size).toBe(2);

    const contents = session!.conversationHistory.ids.map(
      (id) => session!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('first concurrent message');
    expect(contents).toContain('second concurrent message');
  });

  it('updates the session conversation history after each run', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('hello world').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

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
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    // First run: generate sees only the initial user message.
    await h.run('first message').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Second run: generate must see the first run's messages PLUS the new one.
    await h.run('second message').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

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
  it('PRRT_kwDORvupsc6MV8XO regression: persists running RunRef before awaiting completion', async () => {
    // Use a blocking generate so the run stays in-flight long enough to inspect.
    let resolveGenerate!: () => void;
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });

    const blockingGenerate: GenerateFunction = () => {
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
        signalGenerateStarted();
      });
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('running-ref-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    const run = h.run('do something');

    // Wait until generate is executing (i.e. the session has been loaded and
    // the 'running' ref has been persisted).
    await generateStarted;

    // The store MUST contain a running ref while the run is still in-flight.
    const mid = await store.load('running-ref-session');
    expect(mid).toBeDefined();
    expect(mid!.runs).toHaveLength(1);
    expect(mid!.runs[0]!.status).toBe('running');
    expect(mid!.runs[0]!.runId).toBe('running-ref-session:0');

    // Resolve the generate so the run can finish.
    resolveGenerate();
    await run.result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // After completion, the ref must be updated to a terminal status in-place
    // (still only 1 RunRef — not appended).
    const final = await store.load('running-ref-session');
    expect(final!.runs).toHaveLength(1);
    expect(final!.runs[0]!.status).toBe('completed');
    expect(final!.runs[0]!.runId).toBe('running-ref-session:0');
  });

  // Regression: Finding PRRT_kwDORvupsc6MUE_1 — run() never routed through the
  // Weft durable engine even when engine+checkpointStore were present. After the
  // fix, a new run must start via engine.start() so it is checkpointed and
  // reachable via signal/update/query/recover().
  it('F2 regression: run() routes through the Weft engine when engine+checkpointStore are present', async () => {
    const startedIds: string[] = [];

    // A minimal fake engine that records the ids passed to start().
    const fakeEngine = {
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        startedIds.push(opts.id);
        // Return a minimal handle whose result() rejects so the run terminates.
        const aborted = AbortSignal.abort();
        return {
          id: opts.id,
          result: () => Promise.reject(new Error('fake engine')),
          abort: () => {},
          signal: aborted,
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

    const fakeCheckpointStore = {
      loadCheckpoint: async (_runId: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('f2-regression-session', {
      store,
      agentName: 'f2-agent',
      engine: fakeEngine,
      checkpointStore:
        fakeCheckpointStore as unknown as import('../durable/checkpoint-store').CheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    // Start the run and let it settle (the fake engine immediately rejects,
    // so the result promise will reject too — we swallow that).
    const run = h.run('durable please');
    await run.result().catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // The durable engine's start() must have been called with the derived id
    // in `${sessionId}:${sequence}` format.
    expect(startedIds).toHaveLength(1);
    expect(startedIds[0]).toBe('f2-regression-session:0');
  });
});

// ---------------------------------------------------------------------------
// recover() — re-attach to the in-flight run
// ---------------------------------------------------------------------------

describe('session.recover()', () => {
  it('returns null when no run is in flight', async () => {
    const { handle } = createSessionHandleFixture();
    expect(await handle.recover()).toBeNull();
  });

  it('returns the same AgentRun handle while a run is in progress', async () => {
    // Use a blocking generate to keep the run in-flight.
    let resolveGenerate: ((r: { content: string; toolCalls: [] }) => void) | undefined;
    const blockingGenerate: GenerateFunction = () =>
      new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = resolve;
      });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const blockingHandle = createSessionHandle('blocking-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    const run = blockingHandle.run('hold on');
    const recovered = await blockingHandle.recover();

    // The handle is set synchronously in run(), recovered after one await tick.
    expect(recovered).toBe(run);

    // Yield a tick so the run loop starts and resolveGenerate is assigned.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Clean up: resolve the blocking generate so the run can finish.
    resolveGenerate?.({ content: 'done', toolCalls: [] });
    await run.result();
  });

  it('returns null after the run completes', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('quick run');
    await run.result();
    // Allow the `.finally()` callback to clear currentRun.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(await handle.recover()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancel() — abort the in-flight run
// ---------------------------------------------------------------------------

describe('session.cancel()', () => {
  it('aborts the current run and clears the in-flight reference', async () => {
    let abortCalled = false;
    let resolveGenerate: (() => void) | undefined;
    // Resolves once blockingGenerate has been called and the abort listener is
    // registered. We await this before cancelling so the test is robust to the
    // async session-load that now precedes run execution.
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });

    const blockingGenerate: GenerateFunction = (_ctx) => {
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
        if (_ctx.signal) {
          _ctx.signal.addEventListener('abort', () => {
            abortCalled = true;
          });
        }
        // Signal that the generate function is blocking and the abort listener
        // is now attached, so the test can safely call cancel().
        signalGenerateStarted();
      });
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('cancel-session', {
      store,
      agentName: 'cancel-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    h.run('please stop me');

    // Wait until the generate function is actually being called (which happens
    // after the session is loaded asynchronously). Only then is the abort
    // listener attached and cancel() will reliably trigger it.
    await generateStarted;

    expect(await h.recover()).not.toBeNull();
    await h.cancel();

    // The abort signal should have fired.
    expect(abortCalled).toBe(true);
    // The handle should be cleared.
    expect(await h.recover()).toBeNull();

    // Allow the run to finish so we don't leave dangling promises.
    resolveGenerate?.();
  });

  it('is a no-op when no run is in flight', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.cancel();
    expect(result).toBeUndefined();
  });

  it('cancels the Weft workflow when an engine is present', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = {
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

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
          startedAt: new Date().toISOString(),
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
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    await h.cancel();

    expect(cancelledIds).toContain('durable-session:0');

    // Verify the session's run status was updated to 'aborted'.
    const updated = await store.load('durable-session');
    expect(updated!.runs[0]!.status).toBe('aborted');
  });

  it('cancels the current handle run instead of the last session run', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = {
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

    const generateStartedResolvers: Array<() => void> = [];
    const generateStarted = [0, 1].map(
      (index) =>
        new Promise<void>((resolve) => {
          generateStartedResolvers[index] = resolve;
        }),
    );
    const resolveGenerate: Array<() => void> = [];
    let generateCallIndex = 0;
    const blockingGenerate: GenerateFunction = () => {
      const index = generateCallIndex++;
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate[index] = () => resolve({ content: `done ${index}`, toolCalls: [] });
        generateStartedResolvers[index]?.();
      });
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const runOptions = {
      generate: blockingGenerate,
      toolbox: createToolbox([]) as unknown as Toolbox,
      maximumSteps: 1,
    };
    const firstHandle = createSessionHandle('shared-cancel-session', {
      store,
      agentName: 'cancel-agent',
      engine: fakeEngine,
      runOptions,
    });
    const secondHandle = createSessionHandle('shared-cancel-session', {
      store,
      agentName: 'cancel-agent',
      engine: fakeEngine,
      runOptions,
    });

    const firstRun = firstHandle.run('first');
    const secondRun = secondHandle.run('second');
    void firstRun.result().catch(() => {});
    void secondRun.result().catch(() => {});
    await Promise.all(generateStarted);

    await firstHandle.cancel();

    expect(cancelledIds).toEqual(['shared-cancel-session:0']);
    const updated = await store.load('shared-cancel-session');
    expect(updated!.runs.map((run) => [run.runId, run.status])).toEqual([
      ['shared-cancel-session:0', 'aborted'],
      ['shared-cancel-session:1', 'running'],
    ]);

    resolveGenerate[0]?.();
    resolveGenerate[1]?.();
    await Promise.allSettled([firstRun.result(), secondRun.result()]);
  });
});

// ---------------------------------------------------------------------------
// fork() — branch the session
// ---------------------------------------------------------------------------

describe('session.fork()', () => {
  it('creates a new session with a different id', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession(); // ensure session exists

    const forked = await handle.fork();
    expect(forked.id).not.toBe(handle.id);
  });

  it('the forked session starts with an empty runs[]', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    expect(forkedSession.runs).toHaveLength(0);
  });

  it('the forked session copies the conversation history', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-history-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(createInstantGenerate('copied')),
    });

    await h.run('something').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const sourceSession = await store.load('fork-history-source');
    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    // Conversation history should be the same as the source.
    expect(forkedSession.conversationHistory).toEqual(sourceSession!.conversationHistory);
  });

  it('the forked handle returns itself from getSession()', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession();

    const forked = await handle.fork();
    const session = await forked.getSession();
    expect(session.id).toBe(forked.id);
  });

  // Regression: PRRT_kwDORvupsc6MXEmV — fork({ throughRun: n }) must not
  // silently include conversation history from runs after n. Without per-run
  // snapshots, forking before the last run is rejected with ForkThroughRunError
  // instead of silently returning a contaminated branch.
  it('throws ForkThroughRunError when throughRun points before the last run (contamination guard)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    // Complete two runs so that run 0 is followed by run 1 (last index = 1).
    await h.run('first run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await h.run('second run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // fork({ throughRun: 0 }) would branch before run 1, but the full history
    // includes run 1's messages — silently contaminating the branch. Must throw.
    let threw = false;
    try {
      await h.fork({ throughRun: 0 });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ForkThroughRunError);
    }
    expect(threw).toBe(true);
  });

  it('fork({ throughRun: lastIndex }) succeeds (no contamination possible)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-last', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await h.run('second run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // throughRun: 1 is the last run index — no later runs exist, so the full
    // history is correct for this fork point.
    const forked = await h.fork({ throughRun: 1 });
    expect(forked.id).toBeDefined();
    const session = await forked.getSession();
    expect(session.runs).toHaveLength(0);
  });

  it('fork() with no options succeeds regardless of run count', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-default', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await h.run('second run').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Default fork (no throughRun) always copies full history — no guard needed.
    const forked = await h.fork();
    expect(forked.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sleep() — durable pause
// ---------------------------------------------------------------------------

describe('session.sleep()', () => {
  it('resolves after the specified milliseconds (in-memory path)', async () => {
    const { handle } = createSessionHandleFixture();
    const start = Date.now();
    await handle.sleep(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });

  it('parses ISO-8601 PT duration strings', async () => {
    const { handle } = createSessionHandleFixture();
    const start = Date.now();
    await handle.sleep('PT0.01S'); // 10ms
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });

  // Regression: PRRT_kwDORvupsc6Mc3gS — sleep() must reject non-ISO-8601
  // duration strings the same way monitor({ every }) does. parseDuration()
  // returns 0 for unrecognised strings (e.g. '5m' instead of 'PT5M'), which
  // previously made the session resume immediately instead of pausing.
  it('throws when given a non-ISO-8601 duration string (PRRT_kwDORvupsc6Mc3gS)', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.sleep('5m'); // not 'PT5M' — parseDuration returns 0
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid duration string/i);
  });

  it('does not throw for an explicit numeric 0 (zero is a valid millisecond value)', async () => {
    const { handle } = createSessionHandleFixture();
    // A numeric 0 is a deliberate no-delay sleep — only string parse-to-0 is rejected.
    await handle.sleep(0);
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signal() — fire-and-forget signal
// ---------------------------------------------------------------------------

describe('session.signal()', () => {
  it('throws NoDurableEngineError when no engine is present', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    // Pre-load a session with a running run.
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-no-engine',
      runs: [
        {
          runId: 'signal-no-engine:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('signal-no-engine', {
      store,
      agentName: 'agent',
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    let threw = false;
    try {
      await h.signal('approve');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(NoDurableEngineError);
    }
    expect(threw).toBe(true);
  });

  it('throws NoRunningRunError when the last run is terminal', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-terminal',
      runs: [
        {
          runId: 'signal-terminal:0',
          sequence: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = {
      signal: async () => {},
    } as unknown as AnyRunEngine;

    const h = createSessionHandle('signal-terminal', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    let threw = false;
    try {
      await h.signal('approve');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(NoRunningRunError);
    }
    expect(threw).toBe(true);
  });

  it('calls engine.signal with the run id, name, and payload', async () => {
    const signalCalls: Array<{ id: string; name: string; payload: unknown }> = [];

    const fakeEngine = {
      signal: async (id: string, name: string, payload: unknown) => {
        signalCalls.push({ id, name, payload });
      },
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-running',
      runs: [
        {
          runId: 'signal-running:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('signal-running', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    await h.signal('human-response', { approved: true });

    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]).toEqual({
      id: 'signal-running:0',
      name: 'human-response',
      payload: { approved: true },
    });
  });
});

// ---------------------------------------------------------------------------
// update() — validated request/response
// ---------------------------------------------------------------------------

describe('session.update()', () => {
  it('throws NoDurableEngineError when no engine is present', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'update-no-engine',
      runs: [
        {
          runId: 'update-no-engine:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('update-no-engine', {
      store,
      agentName: 'agent',
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    let threw = false;
    try {
      await h.update('params', { temp: 0.5 });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(NoDurableEngineError);
    }
    expect(threw).toBe(true);
  });

  it('calls engine.update and returns the result', async () => {
    const fakeEngine = {
      update: mock(async (_id: string, _name: string, _payload: unknown) => ({ ok: true })),
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'update-running',
      runs: [
        {
          runId: 'update-running:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('update-running', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    const result = await h.update('params', { temp: 0.5 });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// query() — read-only introspection
// ---------------------------------------------------------------------------

describe('session.query()', () => {
  it('throws NoDurableEngineError when no engine is present', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-no-engine',
      runs: [
        {
          runId: 'query-no-engine:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('query-no-engine', {
      store,
      agentName: 'agent',
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    let threw = false;
    try {
      await h.query('current-step');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(NoDurableEngineError);
    }
    expect(threw).toBe(true);
  });

  it('throws NoRunningRunError when the session has no runs', async () => {
    const fakeEngine = {
      query: mock(async () => ({})),
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-no-runs',
    });
    await store.save(session);

    const h = createSessionHandle('query-no-runs', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    let threw = false;
    try {
      await h.query('current-step');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(NoRunningRunError);
    }
    expect(threw).toBe(true);
  });

  it('calls engine.query with the last run id and returns the result', async () => {
    const fakeEngine = {
      query: mock(async (_id: string, _name: string) => ({ step: 3 })),
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-live',
      runs: [
        {
          runId: 'query-live:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('query-live', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    const result = await h.query<{ step: number }>('current-step');
    expect(result).toEqual({ step: 3 });
  });

  it('works on a terminal run (durable fidelity)', async () => {
    const fakeEngine = {
      query: mock(async () => ({ step: 5, status: 'completed' })),
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-terminal',
      runs: [
        {
          runId: 'query-terminal:0',
          sequence: 0,
          status: 'completed', // terminal — not running
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('query-terminal', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    // query() works on any session, running or not.
    const result = await h.query('history');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: run → recover → cancel
// ---------------------------------------------------------------------------

describe('session full lifecycle', () => {
  it('run then recover then cancel follows disconnect-vs-stop model', async () => {
    let resolveGenerate: (() => void) | undefined;
    const blockingGenerate: GenerateFunction = () =>
      new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
      });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('lifecycle-session', {
      store,
      agentName: 'lifecycle-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    // Start the run.
    const run = h.run('start');
    expect(run).toBeDefined();

    // Yield to let the run loop start.
    await Promise.resolve();

    // A "disconnect" — recover() returns the same handle (keep going).
    const recovered = await h.recover();
    expect(recovered).toBe(run);

    // A "deliberate stop" — cancel() aborts the run.
    await h.cancel();

    // After cancel, recover() returns null.
    expect(await h.recover()).toBeNull();

    // Clean up.
    resolveGenerate?.();
  });
});

// ---------------------------------------------------------------------------
// RunRef sequence invariant
// ---------------------------------------------------------------------------

describe('RunRef sequence invariant', () => {
  it('runId is always ${sessionId}:${sequence}', async () => {
    const { handle, store } = createSessionHandleFixture({ sessionId: 'seq-test' });

    await handle.run('run 0').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await handle.run('run 1').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await handle.run('run 2').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load('seq-test');
    expect(session!.runs).toHaveLength(3);
    for (const ref of session!.runs) {
      expect(ref.runId).toBe(`seq-test:${ref.sequence}`);
    }
  });

  it('sequences are monotonically increasing starting from 0', async () => {
    const { handle, store } = createSessionHandleFixture({ sessionId: 'monotonic-test' });

    await handle.run('a').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await handle.run('b').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load('monotonic-test');
    const sequences = session!.runs.map((r) => r.sequence);
    expect(sequences).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Session verb event dispatch (C3 completeness rule — every new state
// transition emits an event). Verifies that each verb dispatches the
// corresponding typed event on the handle's emitter.
// ---------------------------------------------------------------------------

/**
 * Helper: collect events of a given type from a handle's emitter.
 */
function collectEvents<K extends keyof OperativeEventMap & string>(
  emitter: TypedEventTarget<OperativeEventMap>,
  type: K,
): OperativeEventMap[K][] {
  const collected: OperativeEventMap[K][] = [];
  emitter.addEventListener(type, (e) => {
    collected.push(e);
  });
  return collected;
}

describe('session verb event dispatch (C3 completeness rule)', () => {
  it('recover() dispatches SessionRecoverEvent on the emitter', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('recover-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.recover');
    await h.recover();

    expect(events).toHaveLength(1);
    const e = events[0] as SessionRecoverEvent;
    expect(e.type).toBe('session.recover');
    expect(e.sessionId).toBe('recover-event-session');
  });

  it('cancel() dispatches SessionCancelEvent on the emitter', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('cancel-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.cancel');
    await h.cancel();

    expect(events).toHaveLength(1);
    const e = events[0] as SessionCancelEvent;
    expect(e.type).toBe('session.cancel');
    expect(e.sessionId).toBe('cancel-event-session');
  });

  it('fork() dispatches SessionForkEvent on the emitter after persisting', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('fork-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });
    await h.getSession(); // ensure source session exists

    const events = collectEvents(emitter, 'session.fork');
    const forked = await h.fork({ throughRun: 0 });

    expect(events).toHaveLength(1);
    const e = events[0] as SessionForkEvent;
    expect(e.type).toBe('session.fork');
    expect(e.sourceSessionId).toBe('fork-event-session');
    expect(e.forkedSessionId).toBe(forked.id);
    expect(e.throughRun).toBe(0);
  });

  it('sleep() dispatches SessionSleepEvent before sleeping', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('sleep-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.sleep');
    await h.sleep(5); // 5ms so the test stays fast

    expect(events).toHaveLength(1);
    const e = events[0] as SessionSleepEvent;
    expect(e.type).toBe('session.sleep');
    expect(e.sessionId).toBe('sleep-event-session');
    expect(e.durationMs).toBe(5);
  });

  it('signal() dispatches SessionSignalEvent after resolving the run id', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-event-session',
      runs: [
        {
          runId: 'signal-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = {
      signal: mock(async () => {}),
    } as unknown as AnyRunEngine;

    const h = createSessionHandle('signal-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.signal');
    await h.signal('approve', { ok: true });

    expect(events).toHaveLength(1);
    const e = events[0] as SessionSignalEvent;
    expect(e.type).toBe('session.signal');
    expect(e.sessionId).toBe('signal-event-session');
    expect(e.runId).toBe('signal-event-session:0');
    expect(e.signalName).toBe('approve');
    expect(e.payload).toEqual({ ok: true });
  });

  it('update() dispatches SessionUpdateEvent after resolving the run id', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'update-event-session',
      runs: [
        {
          runId: 'update-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = {
      update: mock(async () => ({ ok: true })),
    } as unknown as AnyRunEngine;

    const h = createSessionHandle('update-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.update');
    await h.update('params', { temp: 0.7 });

    expect(events).toHaveLength(1);
    const e = events[0] as SessionUpdateEvent;
    expect(e.type).toBe('session.update');
    expect(e.sessionId).toBe('update-event-session');
    expect(e.runId).toBe('update-event-session:0');
    expect(e.updateName).toBe('params');
    expect(e.payload).toEqual({ temp: 0.7 });
  });

  it('query() dispatches SessionQueryEvent after resolving the last run', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-event-session',
      runs: [
        {
          runId: 'query-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = {
      query: mock(async () => ({ step: 3 })),
    } as unknown as AnyRunEngine;

    const h = createSessionHandle('query-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.query');
    await h.query('status', { detail: 'full' });

    expect(events).toHaveLength(1);
    const e = events[0] as SessionQueryEvent;
    expect(e.type).toBe('session.query');
    expect(e.sessionId).toBe('query-event-session');
    expect(e.queryName).toBe('status');
    expect(e.input).toEqual({ detail: 'full' });
  });

  it('handle.emitter is accessible for subscribing to session verb events', () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('emitter-access-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    // The emitter is accessible without injecting one.
    expect(h.emitter).toBeDefined();
    expect(typeof h.emitter.addEventListener).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// D2 — Recovery-on-boot (recoverAll) — ACCEPTANCE (invariant #4)
//
// Crash → restart → rebuild bureau with same store → in-flight runs auto-resume
// from last checkpoint. Step-granular: completed steps are intact, the in-flight
// step re-runs on reconnect.
//
// The probe workflow is a simple one-step counter that uses a durable sleep to
// park between steps so we can simulate a crash (dispose the first engine) and
// verify the second engine picks up where the first left off.
// ---------------------------------------------------------------------------

/**
 * A trivial workflow that uses a services-backed activity so the run's deps
 * can be re-provided on recovery. Named `agentRun` to match the registered
 * workflow type. The workflow returns `{ steps: 1 }` on completion.
 */
function makeProbeWorkflow() {
  const probe = activity({
    name: 'probe',
    execute: async () => ({ ok: true }),
  });
  return workflow({ name: 'agentRun' })
    .activities({ probe })
    .execute(async function* (ctx) {
      yield* ctx.run('probe', {});
      return { runId: '', steps: 1, content: 'done', finishReason: 'stop-condition' as const };
    });
}

/**
 * A workflow that parks on a durable sleep so we can dispose the engine
 * mid-flight and prove recovery picks it up.
 */
function makeParkingWorkflow(sleepMs: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.sleep(sleepMs);
    return { runId: '', steps: 1, content: 'resumed', finishReason: 'stop-condition' as const };
  });
}

describe('D2 — Recovery-on-boot: session.recover() durable re-attach path', () => {
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

  it('returns null when engine is present but last run status is completed', async () => {
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
            startedAt: new Date().toISOString(),
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
          startedAt: new Date().toISOString(),
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
    } finally {
      engine2[Symbol.dispose]();
    }
  });

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
          startedAt: new Date().toISOString(),
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

      // Let the recovered run finish so no dangling promises.
      await reattached!.result();
    } finally {
      engine2[Symbol.dispose]();
    }
  });

  it('returns null (gracefully) when engine.resume() throws for an unknown run', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createSessionStore(kv);

    // Pre-seed a session with a 'running' run that has NO corresponding workflow
    // in the engine (simulate a run that was never actually started durably).
    const sessionId = 'd2-unknown-run-session';
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId: `${sessionId}:0`,
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      const h = createSessionHandle(sessionId, {
        store,
        agentName: 'agent',
        engine,
        checkpointStore,
        runOptions: createTestRunOptions(),
      });

      // engine.resume() will throw because no workflow with that id exists.
      // recover() must return null rather than propagating the error.
      const reattached = await h.recover();
      expect(reattached).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

// session.monitor() — durable conditional watch loop (D7)
// ---------------------------------------------------------------------------

describe('session.monitor()', () => {
  it('returns true when the predicate is satisfied on the first tick', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.monitor({
      every: 5,
      input: 'check the deploy',
      until: () => true,
    });
    expect(result).toBe(true);
  });

  it('returns true after multiple ticks when the predicate eventually returns true', async () => {
    const { handle } = createSessionHandleFixture();
    let callCount = 0;
    const result = await handle.monitor({
      every: 5,
      input: 'poll',
      until: () => {
        callCount += 1;
        return callCount >= 3;
      },
    });
    expect(result).toBe(true);
    expect(callCount).toBe(3);
  });

  it('returns false when the maxDuration deadline is reached before the predicate is met', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.monitor({
      every: 1,
      input: 'poll',
      until: () => false,
      maxDuration: 5, // Only 5ms — ticks take ~1ms each so this will hit the deadline quickly
    });
    expect(result).toBe(false);
  });

  it('accepts ISO-8601 duration strings for every and maxDuration', async () => {
    const { handle } = createSessionHandleFixture();
    // 'PT0.01S' = 10ms; maxDuration 'PT0.005S' = 5ms → should expire before the first tick interval
    const result = await handle.monitor({
      every: 'PT0.05S', // 50ms between ticks
      input: 'poll',
      until: () => false,
      maxDuration: 'PT0.01S', // 10ms total — less than one full cycle
    });
    expect(result).toBe(false);
  });

  it('each tick executes a full agent run and the predicate receives the RunResult', async () => {
    const { handle } = createSessionHandleFixture(undefined);
    const results: string[] = [];
    await handle.monitor({
      every: 5,
      input: 'check status',
      until: (runResult) => {
        results.push(runResult.finishReason);
        return results.length >= 2;
      },
    });
    // Each tick completes a run; finishReason should be populated.
    expect(results).toHaveLength(2);
    expect(results[0]).toBeDefined();
  });

  it('dispatches SessionMonitorTickEvent on each tick', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-tick-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const tickEvents: SessionMonitorTickEvent[] = [];
    emitter.addEventListener('session.monitor.tick', (e) => {
      tickEvents.push(e);
    });

    let count = 0;
    await h.monitor({
      every: 5,
      input: 'tick check',
      until: () => {
        count += 1;
        return count >= 2;
      },
    });

    // Each tick emits TWO events: one at tick-started (met=null) and one after
    // predicate evaluation (met=true|false). With 2 ticks we expect 4 events.
    expect(tickEvents.length).toBeGreaterThanOrEqual(2);
    // First event of first tick: met=null (run hasn't completed yet).
    expect(tickEvents[0]!.sessionId).toBe('monitor-tick-session');
    expect(tickEvents[0]!.tick).toBe(0);
    expect(tickEvents[0]!.met).toBeNull();
    // Second event of first tick: met=false (predicate returned false).
    expect(tickEvents[1]!.met).toBe(false);
    // Second tick: met=true (predicate returned true).
    const lastTickEvent = tickEvents[tickEvents.length - 1];
    expect(lastTickEvent!.met).toBe(true);
  });

  it('dispatches SessionMonitorDoneEvent when the condition is met', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-done-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const doneEvents: SessionMonitorDoneEvent[] = [];
    emitter.addEventListener('session.monitor.done', (e) => {
      doneEvents.push(e);
    });

    await h.monitor({
      every: 5,
      input: 'check',
      until: () => true,
    });

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.sessionId).toBe('monitor-done-session');
    expect(doneEvents[0]!.met).toBe(true);
    expect(doneEvents[0]!.ticks).toBe(1);
  });

  it('dispatches SessionMonitorDoneEvent(met=false) when maxDuration expires', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-deadline-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const doneEvents: SessionMonitorDoneEvent[] = [];
    emitter.addEventListener('session.monitor.done', (e) => {
      doneEvents.push(e);
    });

    await h.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 5,
    });

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.met).toBe(false);
  });

  it('accumulates runs in the session for each tick', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-runs-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    let count = 0;
    await h.monitor({
      every: 5,
      input: 'poll',
      until: () => {
        count += 1;
        return count >= 2;
      },
    });

    // Give persistence callbacks a moment to flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const session = await store.load('monitor-runs-session');
    // 2 ticks × 1 run each.
    expect(session!.runs.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZ-vl — abort() forwards to the durable inner run
// ---------------------------------------------------------------------------

describe('regression: abort() forwards to the durable inner run (PRRT_kwDORvupsc6MZ-vl)', () => {
  it('calls engine.cancel() on the durable run when AgentRun.abort() is called', async () => {
    const cancelledIds: string[] = [];

    // Signal from inside engine.start() so the test knows driveStarted=true and
    // the inner ActiveRun is live. Using start() rather than generate() because
    // the generate is called by the Weft workflow body, which is never reached
    // with a fake engine — start() is called synchronously in the microtask
    // immediately after driveStarted becomes true.
    let signalStarted!: () => void;
    const engineStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    // cancel() resolves this so the blocked handle.result() can reject and the
    // run can terminate after the assertion.
    let rejectHandle!: (err: Error) => void;
    const handleResult = new Promise<never>((_resolve, reject) => {
      rejectHandle = reject;
    });

    // Fake engine that:
    //   start() — signals the test, then returns a handle that blocks on result()
    //   cancel() — records the runId (assertion target) and unblocks the handle
    const fakeEngine = {
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        signalStarted();
        return {
          id: opts.id,
          result: () => handleResult,
          abort: () => {},
          signal: AbortSignal.abort(),
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async (id: string) => {
        cancelledIds.push(id);
        // Unblock the handle so driveDurableRun can complete and the run settles.
        rejectHandle(new Error('cancelled by test'));
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

    const fakeCheckpointStore = {
      loadCheckpoint: async (_runId: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const sessionId = 'abort-forward-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'abort-agent',
      engine: fakeEngine,
      checkpointStore:
        fakeCheckpointStore as unknown as import('../durable/checkpoint-store').CheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    const agentRun = h.run('go');

    // Wait until engine.start() has been called — at this point driveStarted is
    // true and `activeInnerRun` is set, so abort() will forward to the inner run.
    await engineStarted;

    // Abort the outer AgentRun.
    agentRun.abort('test-abort');

    // Allow the abort to propagate through the promise chain.
    await yieldToPortableEventLoop();

    // engine.cancel() must have been called, proving the abort was forwarded
    // through the inner durable ActiveRun to the Weft engine. Without the fix
    // only the AbortController signal fires and any parked Weft workflow is
    // never cancelled.
    expect(cancelledIds).toContain(`${sessionId}:0`);

    // Swallow the result promise to avoid unhandled rejection (the fake engine's
    // start() returns a never-settling handle, so result() never resolves).
    await agentRun.result().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6Ma-Dr — [Symbol.dispose]() forwards to the inner
// durable run so engine.cancel() is called for parked workflows
// ---------------------------------------------------------------------------

describe('regression: [Symbol.dispose]() forwards to the durable inner run (PRRT_kwDORvupsc6Ma-Dr)', () => {
  it('calls engine.cancel() on the durable run when AgentRun[Symbol.dispose]() is called', async () => {
    const cancelledIds: string[] = [];

    // Signal from inside engine.start() so we know activeInnerRun is set.
    let signalStarted!: () => void;
    const engineStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    // cancel() resolves this so the blocked handle.result() can reject and the
    // run can terminate after the assertion.
    let rejectHandle!: (err: Error) => void;
    const handleResult = new Promise<never>((_resolve, reject) => {
      rejectHandle = reject;
    });

    // Fake engine: start() signals the test and blocks; cancel() records the id.
    const fakeEngine = {
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        signalStarted();
        return {
          id: opts.id,
          result: () => handleResult,
          abort: () => {},
          signal: AbortSignal.abort(),
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async (id: string) => {
        cancelledIds.push(id);
        rejectHandle(new Error('cancelled by dispose'));
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

    const fakeCheckpointStore = {
      loadCheckpoint: async (_runId: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const sessionId = 'dispose-forward-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'dispose-agent',
      engine: fakeEngine,
      checkpointStore:
        fakeCheckpointStore as unknown as import('../durable/checkpoint-store').CheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
        maximumSteps: 1,
      },
    });

    const agentRun = h.run('go');

    // Wait until engine.start() has been called — activeInnerRun is now set.
    await engineStarted;

    // Dispose the outer AgentRun handle (the public API named in the finding).
    agentRun[Symbol.dispose]();

    // Allow disposal to propagate through the promise chain.
    await yieldToPortableEventLoop();

    // engine.cancel() must have been called, proving [Symbol.dispose]() forwarded
    // through activeInnerRun to the Weft engine — not just firing the AbortController.
    // Before the fix, cancel() was never called, leaving parked workflows running.
    expect(cancelledIds).toContain(`${sessionId}:0`);

    // Swallow the result promise to avoid unhandled rejection.
    await agentRun.result().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZ-vp — only mark session aborted when cancel succeeds
// ---------------------------------------------------------------------------

describe('regression: cancel() only persists aborted status when engine.cancel() succeeds (PRRT_kwDORvupsc6MZ-vp)', () => {
  it('does not update the session store to aborted when engine.cancel() throws', async () => {
    const fakeEngine = {
      cancel: async (_id: string) => {
        throw new Error('storage fault');
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as AnyRunEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    // Pre-load a session with a running run ref so cancel() has something to act on.
    const runningSession = createAgentSession({
      agentName: 'durable-agent',
      conversationHistory: createConversationHistory(),
      id: 'cancel-throws-session',
      runs: [
        {
          runId: 'cancel-throws-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: 'durable-agent',
        },
      ],
    });
    await store.save(runningSession);

    const h = createSessionHandle('cancel-throws-session', {
      store,
      agentName: 'durable-agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]) as unknown as Toolbox,
      },
    });

    // cancel() must not reject even when engine.cancel() throws — the error is
    // non-fatal per the architecture comment. `await h.cancel()` would throw if
    // the rejection propagated; passing here proves it is swallowed correctly.
    const cancelResult = await h.cancel();
    expect(cancelResult).toBeUndefined();

    // The session must NOT be marked 'aborted' because the durable workflow
    // cancel failed — its actual status is still 'running' in Weft's store.
    const updated = await store.load('cancel-throws-session');
    expect(updated!.runs[0]!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZ-vv — monitor() rejects invalid duration strings
// ---------------------------------------------------------------------------

describe('regression: monitor() rejects invalid duration strings instead of spinning (PRRT_kwDORvupsc6MZ-vv)', () => {
  it('throws immediately when every is a non-ISO-8601 duration string', async () => {
    const { handle } = createSessionHandleFixture();

    // '5m', '1hour', 'five minutes' etc. are NOT valid ISO-8601 PT durations.
    // parseDuration() returns 0 for them, which previously caused a tight spin
    // loop. The fix throws an Error instead of silently treating 0 as valid.
    let caught: unknown;
    try {
      await handle.monitor({ every: '5m', input: 'check', until: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid duration string/i);
  });

  it('throws for other common mis-formatted duration strings', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: '1hour', input: 'check', until: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid duration string/i);
  });

  it('accepts valid ISO-8601 PT duration strings without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 'PT5M' is valid — parseDuration returns 300_000, no throw.
    const result = await handle.monitor({
      every: 'PT5M',
      input: 'check',
      until: () => true,
      maxDuration: 1, // 1ms cap so the test finishes instantly
    });
    // maxDuration expires before the first inter-tick sleep, returning false.
    expect(typeof result).toBe('boolean');
  });

  // Regression: PRRT_kwDORvupsc6Ma-Dt — invalid string maxDuration silently
  // skips all ticks. parseDuration('5m') = 0, so Date.now()-startedAt >= 0 is
  // immediately true → returns false before the first tick runs.
  it('throws immediately when maxDuration is a non-ISO-8601 duration string', async () => {
    const { handle } = createSessionHandleFixture();

    let tickCount = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 1,
        input: 'check',
        until: () => {
          tickCount += 1;
          return false;
        },
        maxDuration: '5m', // non-ISO-8601 — parseDuration returns 0
      });
    } catch (err) {
      caught = err;
    }
    // Must throw, not silently return false.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid duration string/i);
    // No tick should have run before the throw.
    expect(tickCount).toBe(0);
  });

  it('throws for other common mis-formatted maxDuration strings', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({
        every: 1,
        input: 'check',
        until: () => false,
        maxDuration: '24h', // should be 'PT24H'
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid duration string/i);
  });

  it('accepts a valid ISO-8601 string for maxDuration without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 'PT0.01S' = 10ms. The first tick runs, then the deadline check fires.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 'PT0.01S', // valid ISO-8601
    });
    // Deadline expired before predicate was met.
    expect(result).toBe(false);
  });

  it('accepts numeric 0 for maxDuration (zero budget is valid, not an error)', async () => {
    const { handle } = createSessionHandleFixture();

    // maxDuration: 0 (number) means "already expired" — returns false immediately.
    // This must NOT throw: neither the string guard nor the numeric guard (0 is a
    // valid non-negative finite value) should fire here.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => true,
      maxDuration: 0,
    });
    expect(result).toBe(false);
  });

  // Regression: PRRT_kwDORvupsc6MkjBe (Cursor Bugbot) — numeric maxDuration was
  // accepted as-is, so NaN/Infinity/negative made the deadline check
  // `Date.now() - startedAt >= maxMs` ALWAYS false → no effective time cap (the
  // loop runs until the predicate passes or a tick throws). The symmetric gap to
  // the numeric `every` guard above.
  it('throws for a non-finite numeric maxDuration (Infinity / NaN) without running unbounded', async () => {
    const { handle } = createSessionHandleFixture();

    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      let tickCount = 0;
      let caught: unknown;
      try {
        await handle.monitor({
          every: 1,
          input: 'check',
          until: () => {
            tickCount += 1;
            return false; // never met — an unbounded loop would run forever
          },
          maxDuration: bad,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/invalid numeric value/i);
      // The throw happens before the loop starts — no tick ran.
      expect(tickCount).toBe(0);
    }
  });

  it('throws for a negative numeric maxDuration', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: 1, input: 'check', until: () => false, maxDuration: -5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid numeric value/i);
  });

  it('accepts a positive finite numeric maxDuration without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 5ms cap with 1ms ticks and a never-met predicate → returns false at the
    // deadline. Proves a valid numeric maxDuration is not rejected.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 5,
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6Mddv9 — monitor() rejects non-positive numeric
// intervals (the string guard above only covered strings; a numeric `every` of
// 0 / negative / non-finite flowed through as everyMs<=0 → no inter-tick sleep
// → tight spin of back-to-back agent runs).
// ---------------------------------------------------------------------------

describe('regression: monitor() rejects non-positive numeric intervals (PRRT_kwDORvupsc6Mddv9)', () => {
  it('throws immediately for every: 0 without running a single tick', async () => {
    const { handle } = createSessionHandleFixture();

    let tickCount = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 0,
        input: 'check',
        until: () => {
          tickCount += 1;
          return false; // never met — a spin loop would run forever
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid numeric interval/i);
    // The throw happens before the loop starts — no tick (and no agent run) ran.
    expect(tickCount).toBe(0);
  });

  it('throws for a negative numeric interval', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: -5, input: 'check', until: () => false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid numeric interval/i);
  });

  it('throws for a non-finite numeric interval (Infinity / NaN)', async () => {
    const { handle } = createSessionHandleFixture();

    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      let caught: unknown;
      try {
        await handle.monitor({ every: bad, input: 'check', until: () => false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/invalid numeric interval/i);
    }
  });

  it('accepts a positive numeric interval without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // every: 5 is valid; predicate met on first tick → returns true.
    const result = await handle.monitor({ every: 5, input: 'check', until: () => true });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MddwB — monitor() stops on a failed tick instead
// of feeding the failure RunResult to the predicate. `run.result()` RESOLVES
// (does not throw) for normal operative failures, so the catch block never ran
// and a predicate returning false kept re-running after provider/tool failures.
// ---------------------------------------------------------------------------

describe('regression: monitor() surfaces failed tick finish reasons (PRRT_kwDORvupsc6MddwB)', () => {
  it("throws (does not call until) when a tick's run finishes with finishReason 'error'", async () => {
    // A generate that throws makes the loop resolve a RunResult with
    // finishReason 'error' (the loop catches the throw internally — run.result()
    // resolves rather than rejects), exactly the case the predicate must not see.
    const failingGenerate: GenerateFunction = async () => {
      throw new Error('provider exploded');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('monitor-fail-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(failingGenerate),
    });

    let predicateCalls = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 5,
        input: 'check',
        until: () => {
          predicateCalls += 1;
          return false; // a spin loop would re-run forever after the failure
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // The original run error is surfaced, not swallowed.
    expect((caught as Error).message).toMatch(/provider exploded/i);
    // The predicate must NEVER see a failed tick.
    expect(predicateCalls).toBe(0);
  });

  it('still evaluates the predicate normally on a successful tick', async () => {
    // Sanity: a healthy run (finishReason 'maximum-steps') is NOT treated as a
    // failure — the predicate runs as before.
    const { handle } = createSessionHandleFixture();
    let predicateCalls = 0;
    const result = await handle.monitor({
      every: 5,
      input: 'check',
      until: () => {
        predicateCalls += 1;
        return true;
      },
    });
    expect(result).toBe(true);
    expect(predicateCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZozl — tool.* bubble events carry derived runId
// ---------------------------------------------------------------------------

describe('regression: tool.* bubble events carry the session run id (PRRT_kwDORvupsc6MZozl)', () => {
  it('stamps tool.started with the derived sessionId:sequence runId on the in-memory path', async () => {
    // Use an echo tool so the generate can trigger a tool call.
    const echoTool = createTool({
      name: 'echo',
      description: 'Echo the input',
      input: z.object({ message: z.string() }),
      execute: async ({ message }: { message: string }) => message,
    });

    // Two-step generate: first step triggers the tool call, second step returns
    // text so maximumSteps:2 lets the loop finish naturally.
    let step = 0;
    const generate: GenerateFunction = async () => {
      step += 1;
      if (step === 1) {
        return { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hello' } }] };
      }
      return { content: 'done', toolCalls: [] };
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const sessionId = 'tool-runid-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      // No engine/checkpointStore → forces the in-memory createActiveRun path.
      runOptions: {
        generate,
        toolbox: createToolbox([echoTool]) as unknown as Toolbox,
        maximumSteps: 2,
      },
    });

    const started: ToolStartedBubbleEvent[] = [];
    const agentRun = h.run('say hello');

    // Collect tool.started events via the async iterator while the run is in-flight.
    const collectEvents = async () => {
      for await (const event of agentRun) {
        if (event.type === 'tool.started') {
          started.push(event as ToolStartedBubbleEvent);
        }
      }
    };
    await Promise.all([agentRun.result(), collectEvents()]);

    // The first run in the session has sequence 0, so its runId is sessionId:0.
    expect(started).toHaveLength(1);
    expect(started[0]?.runId).toBe(`${sessionId}:0`);
    expect(started[0]?.agentName).toBe('test-agent');
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZozh — recover() persists terminal state
// ---------------------------------------------------------------------------

describe('regression: recover() persists terminal state after recovered run settles (PRRT_kwDORvupsc6MZozh)', () => {
  it('updates the session store from running to completed after a recovered durable run settles', async () => {
    // Mirrors the D2 acceptance test but adds a store-state assertion AFTER the
    // recovered run completes, proving the RunRef transitions from 'running' →
    // 'completed' and conversation history is updated.
    const SLEEP_MS = 50;
    const storage = new MemoryStorage();
    const sessionId = 'recover-persist-session';
    const runId = `${sessionId}:0`;

    // --- First "process" ---
    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);

    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });

    // Persist the session with a 'running' run ref (mimics what run() does).
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: 'agent',
        },
      ],
    });
    await firstStore.save(session);

    // Start the durable workflow and let it park on ctx.sleep.
    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    for (let i = 0; i < 10; i++) {
      await yieldToPortableEventLoop();
    }
    // "Crash" — dispose the first engine.
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    // --- Second "process" (restart) ---
    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );

    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: true, // fires the ctx.sleep timer
    });

    try {
      await engine2.recoverAll();

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      const reattached = await h.recover();
      expect(reattached).not.toBeNull();

      // Await the recovered run so we know the settle handler has fired.
      await reattached!.result();
      // Give the async settle handler a tick to complete the store.save.
      await yieldToPortableEventLoop();

      // The persisted RunRef must have transitioned to a terminal status.
      const storedSession = await secondStore.load(sessionId);
      expect(storedSession).not.toBeNull();
      const storedRun = storedSession!.runs[0];
      expect(storedRun?.status).not.toBe('running');
      // The parking workflow returns finishReason:'stop-condition' → 'completed'.
      expect(storedRun?.status).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});
