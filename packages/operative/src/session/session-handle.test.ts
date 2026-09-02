import { activity, workflow } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import type { Toolbox } from 'armorer';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';
import { z } from 'zod';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import { createRunEngine } from '../durable/create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow';
import type {
  OperativeEventMap,
  SessionCancelEvent,
  SessionForkEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionUpdateEvent,
  ToolStartedBubbleEvent,
} from '../events';
import { SessionMonitorDoneEvent, SessionMonitorTickEvent, SessionSleepEvent } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import {
  createSessionHandle,
  deriveRunId,
  ForkThroughRunError,
  NoDurableEngineError,
  NoRunningRunError,
} from './session-handle';
import type { SessionStore } from './types';

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

function createSessionHandleFixture(overrides?: {
  sessionId?: string;
  engine?: RegistryAgnosticEngine;
}) {
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

function createUpdateGate(store: SessionStore): {
  readonly store: SessionStore;
  readonly release: () => void;
} {
  let releaseUpdate: (() => void) | undefined;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });

  return {
    store: {
      ...store,
      async update(...args) {
        await updateGate;
        return store.update(...args);
      },
    },
    release() {
      releaseUpdate?.();
    },
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
        toolbox: createToolbox([]),
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

  it('closed() resolves not-required for a clean completion — delegated straight through from the inner run, which is itself first asked only once it has already settled (AB-204)', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');
    const closedAcknowledgement = run.closed();
    await run.result();

    // This wrapper's own `resolveOutcome` only calls the inner run's
    // `closed()` for the first time AFTER the outer `resultPromise` (which
    // itself awaits the inner run's own result) has already settled — so
    // the inner run's own not-required fast path always applies for an
    // uncancelled completion, regardless of when THIS wrapper's closed()
    // was called. `not-required` here is the delegated value, not a
    // different code path from the "already settled" case below.
    expect(await closedAcknowledgement).toEqual({ status: 'not-required' });
  });

  it('closed() resolves not-required when first called after the run already settled with no cancellation (AB-204)', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');
    await run.result();
    await Promise.resolve();

    expect(await run.closed()).toEqual({ status: 'not-required' });
  });

  it('closed() delegates a non-not-required outcome from the inner run when the run was aborted (AB-204)', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('session run aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('closed-delegates-aborted-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const run = handle.run('abort me');
    await generateStarted;
    run.abort('user stopped it');

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');

    // The wrapper's own cancellation disqualifies ITS not-required fast
    // path (cancelRequested), and the inner run's own cancellation
    // (forwarded via activeInnerRun?.abort()) disqualifies ITS fast path
    // too — so this exercises the real "await the drain, then delegate"
    // path end to end, rather than the trivial not-required short-circuit.
    expect(await run.closed()).toEqual({ status: 'completed' });
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
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

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
        toolbox: createToolbox([]),
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
        toolbox: createToolbox([]),
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

  it('surfaces persistence failures after the inner run resolves', async () => {
    const kv = textValueStore(new MemoryStorage());
    const baseStore = createSessionStore(kv);
    let updateCalls = 0;
    const store: SessionStore = {
      ...baseStore,
      async update(...args) {
        updateCalls += 1;
        if (updateCalls === 2) {
          throw new Error('failed to persist terminal run');
        }
        return baseStore.update(...args);
      },
    };
    const handle = createSessionHandle('terminal-persist-fails', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(createInstantGenerate('done')),
    });

    const run = handle.run('hello');

    try {
      await run.result();
      throw new Error('expected run result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('failed to persist terminal run');
    }
    await yieldToPortableEventLoop();
    expect(updateCalls).toBe(2);
  });

  it('streams run events when iterating a session run', async () => {
    const { handle } = createSessionHandleFixture();
    const agentRun = handle.run('stream events');
    const eventTypes: string[] = [];

    for await (const event of agentRun) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('run.completed');
    const result = await agentRun.result();
    expect(result).toMatchObject({ finishReason: 'maximum-steps' });
  });

  it('aborts a running session run through the AgentRun handle', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('session run aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('abort-agent-run-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const agentRun = handle.run('abort me');
    await generateStarted;
    agentRun.abort('user stopped it');

    const result = await agentRun.result();
    expect(result).toMatchObject({
      finishReason: 'aborted',
    });
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
        toolbox: createToolbox([]),
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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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

  it('does not cancel another run while this handle is reserving a run id', async () => {
    const cancelledIds: string[] = [];
    const fakeEngine = {
      cancel: async (id: string) => {
        cancelledIds.push(id);
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as RegistryAgnosticEngine;

    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'pending-reservation-cancel-session',
      runs: [
        {
          runId: 'pending-reservation-cancel-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: 'agent',
        },
      ],
    });
    await baseStore.save(session);
    const gate = createUpdateGate(baseStore);
    const handle = createSessionHandle('pending-reservation-cancel-session', {
      store: gate.store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: createTestRunOptions(),
    });

    const run = handle.run('new run');
    void run.result().catch(() => {});

    await handle.cancel();

    expect(cancelledIds).toEqual([]);
    const loadedBeforeRelease = await baseStore.load('pending-reservation-cancel-session');
    expect(loadedBeforeRelease!.runs[0]!.status).toBe('running');

    gate.release();
    await Promise.allSettled([run.result()]);
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
// sleep() — process-local delay
// ---------------------------------------------------------------------------

describe('session.sleep()', () => {
  it('does not emit a sleep event when the signal is already aborted', async () => {
    const { handle } = createSessionHandleFixture();
    let sleepEvents = 0;
    handle.emitter.addEventListener(SessionSleepEvent.type, () => {
      sleepEvents += 1;
    });

    let caught: unknown;
    try {
      await handle.sleep('PT1H', { signal: AbortSignal.abort() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(sleepEvents).toBe(0);
  });

  it('clears a timer when abort races with timer registration', async () => {
    const timerToken = Symbol('timer');
    const clearedTimers: unknown[] = [];
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('racing-local-sleep-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
      setTimeoutFunction: () => {
        abortController.abort();
        return timerToken;
      },
      clearTimeoutFunction: (timer) => {
        clearedTimers.push(timer);
      },
    });

    let caught: unknown;
    try {
      await handle.sleep('PT1H', { signal: abortController.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTimers).toEqual([timerToken]);
  });

  it('clears the default process-local timer when aborted', async () => {
    const abortController = new AbortController();
    const { handle } = createSessionHandleFixture();

    const sleeping = handle.sleep('PT1H', { signal: abortController.signal });
    abortController.abort();

    let caught: unknown;
    try {
      await sleeping;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
  });

  it('uses and clears a process-local timer when aborted, even with a durable engine', async () => {
    const timerToken = Symbol('timer');
    const clearedTimers: unknown[] = [];
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const engine = {} as RegistryAgnosticEngine;
    const handle = createSessionHandle('abort-local-sleep-session', {
      store,
      agentName: 'test-agent',
      engine,
      runOptions: createTestRunOptions(),
      setTimeoutFunction: () => timerToken,
      clearTimeoutFunction: (timer) => {
        clearedTimers.push(timer);
      },
    });

    const sleeping = handle.sleep('PT1H', { signal: abortController.signal });
    abortController.abort();

    let caught: unknown;
    try {
      await sleeping;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTimers).toEqual([timerToken]);
  });

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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

    const h = createSessionHandle('signal-terminal', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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

  it('targets the newest running ref when the last run is terminal', async () => {
    const signalCalls: Array<{ id: string; name: string; payload: unknown }> = [];

    const fakeEngine = {
      signal: async (id: string, name: string, payload: unknown) => {
        signalCalls.push({ id, name, payload });
      },
    } as unknown as RegistryAgnosticEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-newest-running',
      runs: [
        {
          runId: 'signal-newest-running:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
        {
          runId: 'signal-newest-running:1',
          sequence: 1,
          status: 'completed',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('signal-newest-running', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
      },
    });

    await h.signal('human-response', { approved: true });

    expect(signalCalls).toEqual([
      {
        id: 'signal-newest-running:0',
        name: 'human-response',
        payload: { approved: true },
      },
    ]);
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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
      },
    });

    const result = await h.update('params', { temp: 0.5 });
    expect(result).toEqual({ ok: true });
  });

  it('targets this handle run for signal, update, and query when another run is later', async () => {
    const targetedIds: Array<{ verb: string; id: string }> = [];
    const fakeEngine = {
      signal: async (id: string) => {
        targetedIds.push({ verb: 'signal', id });
      },
      update: async (id: string) => {
        targetedIds.push({ verb: 'update', id });
        return { ok: true };
      },
      query: async (id: string) => {
        targetedIds.push({ verb: 'query', id });
        return { ok: true };
      },
    } as unknown as RegistryAgnosticEngine;

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
    const firstHandle = createSessionHandle('shared-hitl-session', {
      store,
      agentName: 'hitl-agent',
      engine: fakeEngine,
      runOptions,
    });
    const secondHandle = createSessionHandle('shared-hitl-session', {
      store,
      agentName: 'hitl-agent',
      engine: fakeEngine,
      runOptions,
    });

    const firstRun = firstHandle.run('first');
    const secondRun = secondHandle.run('second');
    void firstRun.result().catch(() => {});
    void secondRun.result().catch(() => {});
    await Promise.all(generateStarted);

    await firstHandle.signal('approve');
    await firstHandle.update('params');
    await firstHandle.query('state');

    expect(targetedIds).toEqual([
      { verb: 'signal', id: 'shared-hitl-session:0' },
      { verb: 'update', id: 'shared-hitl-session:0' },
      { verb: 'query', id: 'shared-hitl-session:0' },
    ]);

    resolveGenerate[0]?.();
    resolveGenerate[1]?.();
    await Promise.allSettled([firstRun.result(), secondRun.result()]);
  });

  it('does not fall back to another run while this handle is reserving a run id', async () => {
    const targetedIds: Array<{ verb: string; id: string }> = [];
    const fakeEngine = {
      signal: async (id: string) => {
        targetedIds.push({ verb: 'signal', id });
      },
      update: async (id: string) => {
        targetedIds.push({ verb: 'update', id });
        return { ok: true };
      },
      query: async (id: string) => {
        targetedIds.push({ verb: 'query', id });
        return { ok: true };
      },
    } as unknown as RegistryAgnosticEngine;

    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'pending-reservation-hitl-session',
      runs: [
        {
          runId: 'pending-reservation-hitl-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: 'agent',
        },
      ],
    });
    await baseStore.save(session);
    const gate = createUpdateGate(baseStore);
    const handle = createSessionHandle('pending-reservation-hitl-session', {
      store: gate.store,
      agentName: 'agent',
      engine: fakeEngine,
      runOptions: createTestRunOptions(),
    });

    const run = handle.run('new run');
    void run.result().catch(() => {});

    for (const operation of [
      () => handle.signal('approve'),
      () => handle.update('params'),
      () => handle.query('state'),
    ]) {
      let threw = false;
      try {
        await operation();
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(NoRunningRunError);
      }
      expect(threw).toBe(true);
    }

    expect(targetedIds).toEqual([]);
    gate.release();
    await Promise.allSettled([run.result()]);
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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
      },
    });

    const result = await h.query<{ step: number }>('current-step');
    expect(result).toEqual({ step: 3 });
  });

  it('works on a terminal run (durable fidelity)', async () => {
    const fakeEngine = {
      query: mock(async () => ({ step: 5, status: 'completed' })),
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
    } as unknown as RegistryAgnosticEngine;

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
    } as unknown as RegistryAgnosticEngine;

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
      return {
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: '',
        steps: 1,
        content: 'done',
        finishReason: 'stop-condition' as const,
      };
    });
}

/**
 * A workflow that parks on a durable sleep so we can dispose the engine
 * mid-flight and prove recovery picks it up.
 */
function makeParkingWorkflow(sleepMs: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.sleep(sleepMs);
    return {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: '',
      steps: 1,
      content: 'resumed',
      finishReason: 'stop-condition' as const,
    };
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

  it('returns null when engine is present but no run is running', async () => {
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

  it('reattaches to a running run even when a later run is terminal', async () => {
    const resumedIds: string[] = [];
    const fakeEngine = {
      resume: async (id: string) => {
        resumedIds.push(id);
        return {
          id,
          result: () => new Promise<unknown>(() => {}),
        };
      },
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_runId: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'earlier-running-session',
      runs: [
        {
          runId: 'earlier-running-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
        {
          runId: 'earlier-running-session:1',
          sequence: 1,
          status: 'completed',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('earlier-running-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore:
        fakeCheckpointStore as unknown as import('../durable/checkpoint-store').CheckpointStore,
      runOptions: createTestRunOptions(),
    });

    const recovered = await h.recover();

    expect(recovered).not.toBeNull();
    expect(resumedIds).toEqual(['earlier-running-session:0']);
  });

  it('tries older running refs when the newest running ref cannot resume', async () => {
    const resumedIds: string[] = [];
    const fakeEngine = {
      resume: async (id: string) => {
        resumedIds.push(id);
        if (id === 'fallback-running-session:1') {
          throw new Error('stale workflow');
        }
        return {
          id,
          result: () => new Promise<unknown>(() => {}),
        };
      },
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_runId: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'fallback-running-session',
      runs: [
        {
          runId: 'fallback-running-session:0',
          sequence: 0,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
        {
          runId: 'fallback-running-session:1',
          sequence: 1,
          status: 'running',
          startedAt: new Date().toISOString(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const h = createSessionHandle('fallback-running-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore:
        fakeCheckpointStore as unknown as import('../durable/checkpoint-store').CheckpointStore,
      runOptions: createTestRunOptions(),
    });

    const recovered = await h.recover();

    expect(recovered).not.toBeNull();
    expect(resumedIds).toEqual(['fallback-running-session:1', 'fallback-running-session:0']);
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

      // AB-28 acceptance: unchanged existing behavior for a run still in
      // flight at recover() time — the RunRef transitions to 'completed' on
      // settle (via the success branch's fire-and-forget write, so poll for
      // it rather than reading the store synchronously).
      let persistedStatus: string | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const persisted = await secondStore.load(sessionId);
        persistedStatus = persisted?.runs.find((r) => r.runId === runId)?.status;
        if (persistedStatus === 'completed') break;
        await yieldToPortableEventLoop();
      }
      expect(persistedStatus).toBe('completed');
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
      // AB-29: the successful re-attach path reports no failures.
      expect(recoverEvents[0]!.failures).toHaveLength(0);

      // Let the recovered run finish so no dangling promises.
      await reattached!.result();
    } finally {
      engine2[Symbol.dispose]();
    }
  });

  it('AB-29: a mixed outcome reports the newer rejection alongside the older successful reattach', async () => {
    const storage = new MemoryStorage();
    const sessionId = 'd2-mixed-outcome-session';
    const olderRunId = `${sessionId}:0`;
    // Never actually started durably — engine.resume() will reject for this one.
    const newerRunId = `${sessionId}:1`;
    const SLEEP_MS = 50;

    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
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
            startedAt: new Date().toISOString(),
            agentName: '',
          },
          {
            runId: newerRunId,
            sequence: 1,
            status: 'running',
            startedAt: new Date().toISOString(),
            agentName: '',
          },
        ],
      }),
    );

    // Only the OLDER run is actually started durably and parked.
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });
    const firstHandle = await engine1.start('agentRun', {}, { id: olderRunId });
    for (let i = 0; i < 10; i++) await yieldToPortableEventLoop();
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

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

      // The newer ref's rejection doesn't prevent falling through to the
      // older, resumable ref.
      expect(reattached).not.toBeNull();

      expect(recoverEvents).toHaveLength(1);
      expect(recoverEvents[0]!.runId).toBe(olderRunId);
      // The newer ref's rejection is still reported, not silently dropped.
      expect(recoverEvents[0]!.failures).toHaveLength(1);
      expect(recoverEvents[0]!.failures[0]!.runId).toBe(newerRunId);

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

      // AB-28: an unknown runId must NOT be reconciled to a terminal status —
      // engine.get() also returns null for it, so the RunRef is left exactly
      // as it was.
      const persisted = await store.load(sessionId);
      expect(persisted?.runs[0]?.status).toBe('running');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // AB-29: a failed durable re-attach must be observable through the
  // handle's emitter, distinguishable from the benign "nothing to resume"
  // outcome, without reading the durable store.
  const fakeCheckpointStore = {
    loadCheckpoint: async (_runId: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }),
  } as unknown as import('../durable/checkpoint-store').CheckpointStore;

  it('reports a rejected engine.resume() as an observable failure, and recover() still returns null', async () => {
    const sessionId = 'ab29-failed-reattach';
    const runId = `${sessionId}:0`;
    const resumeError = new Error('resolveWorkflowServices returned an unusable shape');

    const fakeEngine = {
      resume: async (_workflowId: string) => {
        throw resumeError;
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as RegistryAgnosticEngine;

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
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
            startedAt: new Date().toISOString(),
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

    // recover() keeps its documented disconnect-is-not-an-error contract.
    expect(reattached).toBeNull();

    // The failure is observable from the emitter alone, with the runId and
    // underlying error attached — no durable-store read required.
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0]!.sessionId).toBe(sessionId);
    expect(recoverEvents[0]!.runId).toBeNull();
    expect(recoverEvents[0]!.failures).toHaveLength(1);
    expect(recoverEvents[0]!.failures[0]!.runId).toBe(runId);
    expect(recoverEvents[0]!.failures[0]!.error).toBe(resumeError);
  });

  it('distinguishes "nothing to resume" from a failed reattach via an empty failures array', async () => {
    const sessionId = 'ab29-nothing-to-resume';

    const fakeEngine = {
      resume: async (_workflowId: string) => {
        throw new Error('should never be called: there is no running ref');
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as RegistryAgnosticEngine;

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

  it('reports every rejected runId when multiple running refs are walked', async () => {
    const sessionId = 'ab29-multiple-running-refs';
    const olderRunId = `${sessionId}:0`;
    const newerRunId = `${sessionId}:1`;
    const attemptedRunIds: string[] = [];

    const fakeEngine = {
      resume: async (workflowId: string) => {
        attemptedRunIds.push(workflowId);
        throw new Error(`engine rejected resume for "${workflowId}"`);
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    } as unknown as RegistryAgnosticEngine;

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
            startedAt: new Date().toISOString(),
            agentName: '',
          },
          {
            runId: newerRunId,
            sequence: 1,
            status: 'running',
            startedAt: new Date().toISOString(),
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

// AB-28 — reconcile the RunRef when a recovered run is already terminal
//
// Weft's recoverAll() resumes an in-flight workflow on boot. If that recovered
// run settles BEFORE the host calls session.recover(), engine.resume(runId)
// rejects because the workflow is already terminal. Without reconciliation the
// persisted RunRef stays stranded at 'running' forever. These tests drive that
// rejection with a fake engine (mirroring the "tries older running refs" fake
// above) so the terminal state can be asserted precisely, independent of
// Weft's own timing.
// ---------------------------------------------------------------------------

describe('AB-28: recover() reconciles a RunRef whose recovered run is already terminal', () => {
  function alreadyTerminalError(runId: string, status: string): Error {
    return new Error(
      `Cannot resume workflow "${runId}": status is "${status}", expected "running" or "suspended"`,
    );
  }

  async function seedRunningSession(sessionId: string, runId: string): Promise<SessionStore> {
    const kv = textValueStore(new MemoryStorage());
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
    return store;
  }

  it('reconciles a completed recovered run to "completed" and applies its conversation history', async () => {
    const sessionId = 'ab-28-completed-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const recoveredConversation = new Conversation(createConversationHistory());
    recoveredConversation.appendUserMessage('hi');
    recoveredConversation.appendAssistantMessage('hello');

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId: id,
          steps: 1,
          content: 'hello',
          finishReason: 'stop-condition',
        },
      }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: recoveredConversation.snapshot(),
        cursor: { totalUsage: {}, lastContent: 'hello', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    // Reconciliation is a side effect — recover() still returns null for a
    // terminal run; it does not resurrect it into a live AgentRun.
    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('completed');
    const contents = Object.values(persisted?.conversationHistory.messages ?? {}).map(
      (m) => m.content,
    );
    expect(contents).toContain('hi');
    expect(contents).toContain('hello');
  });

  it('reconciles a recovered run whose finishReason was "error" to "error", not "completed"', async () => {
    const sessionId = 'ab-28-error-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId: id,
          steps: 1,
          content: '',
          finishReason: 'error',
          errorMessage: 'boom',
        },
      }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('error');
  });

  it('contains unsupported terminal result versions as recover failures', async () => {
    const sessionId = 'ab-28-unsupported-version-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const events = collectEvents(emitter, 'session.recover');

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION + 1,
          runId: id,
          steps: 1,
          content: '',
          finishReason: 'stop-condition',
        },
      }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async () => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      emitter,
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();
    expect(events).toHaveLength(1);
    expect((events[0] as SessionRecoverEvent).failures[0]?.error).toBeInstanceOf(
      UnsupportedRunResultVersionError,
    );

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('running');
  });

  it('reconciles a genuinely cancelled Weft-level workflow to "aborted"', async () => {
    const sessionId = 'ab-28-cancelled-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'cancelled');
      },
      get: async (id: string) => ({ id, status: 'cancelled' }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('aborted');
  });

  it('reconciles a genuinely failed Weft-level workflow to "error"', async () => {
    const sessionId = 'ab-28-failed-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'failed');
      },
      get: async (id: string) => ({ id, status: 'failed', error: 'engine blew up' }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => {
        throw new Error('no checkpoint was ever written for this run');
      },
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('error');
  });

  it('leaves the RunRef untouched when engine.get() reports it as still non-terminal', async () => {
    // A defensive case: engine.resume() rejected for some other reason (a
    // transient error, a race), but engine.get() says the workflow is still
    // suspended/running/pending. resume() should have succeeded for a
    // genuinely non-terminal workflow, so reconciliation must not guess at a
    // status here — it leaves the RunRef alone.
    const sessionId = 'ab-28-still-suspended-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = {
      resume: async () => {
        throw new Error('transient resume failure');
      },
      get: async (id: string) => ({ id, status: 'suspended' }),
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

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

    const fakeEngine = {
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async () => {
        throw new Error('storage unavailable');
      },
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: null,
        cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

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
    const fakeEngine = {
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
    } as unknown as RegistryAgnosticEngine;
    const fakeCheckpointStore = {
      loadCheckpoint: async (_id: string) => ({
        conversation: recoveredConversation.snapshot(),
        cursor: { totalUsage: {}, lastContent: 'once', schemaAttempts: 0 },
        steps: [],
      }),
    } as unknown as import('../durable/checkpoint-store').CheckpointStore;

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

  it('reconciles the RunRef against a REAL Weft engine when the recovered run settles before recover() is called', async () => {
    // The reproduction from the issue (CHR-15): process A crashes mid-run,
    // process B resumes it on boot, and it settles to terminal BEFORE the
    // host calls session.recover(). The fake-engine tests above assume a
    // particular shape for engine.get()'s `.result` on a completed workflow
    // — this test exercises the REAL Weft engine to prove that assumption.
    const SLEEP_MS = 20;
    const storage = new MemoryStorage();
    const sessionId = 'ab-28-real-engine-session';
    const runId = `${sessionId}:0`;

    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });

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

    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    for (let i = 0; i < 10; i++) await yieldToPortableEventLoop();
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    // Default recover:true resumes the parked workflow synchronously during
    // creation; startScheduler:true (with a short poll interval) arms the
    // timer so its ctx.sleep actually fires within this test's window.
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      startScheduler: true,
      schedulerPollIntervalMs: 5,
    });

    try {
      // Poll engine.get() until the recovered run settles to terminal BEFORE
      // calling recover() — the exact race the issue describes. Capped at 5
      // attempts per this repo's polling-loop convention.
      let state: Awaited<ReturnType<typeof engine2.get>> = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        state = await engine2.get(runId);
        if (state && state.status !== 'running' && state.status !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS * 2));
      }

      expect(state?.status).toBe('completed');
      // The real shape engine.get() returns .result in — this is exactly
      // what readTerminalRunOutcome() reads to derive the RunRef status.
      const summary = state?.result as { finishReason?: string } | undefined;
      expect(summary?.finishReason).toBe('stop-condition');

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      // recover() must still return null for a terminal run — reconciliation
      // is a side effect, not a resurrection into a live AgentRun.
      const reattached = await h.recover();
      expect(reattached).toBeNull();

      const persisted = await secondStore.load(sessionId);
      expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});

// session.monitor() — process-local conditional watch loop
// ---------------------------------------------------------------------------

describe('session.monitor()', () => {
  it('does not emit a monitor tick when the signal is already aborted', async () => {
    const { handle } = createSessionHandleFixture();
    let tickEvents = 0;
    handle.emitter.addEventListener(SessionMonitorTickEvent.type, () => {
      tickEvents += 1;
    });

    let caught: unknown;
    try {
      await handle.monitor({
        every: 'PT1H',
        input: 'check',
        until: () => false,
        signal: AbortSignal.abort(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(tickEvents).toBe(0);
  });

  it('aborts the active process-local monitor tick', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('monitor tick aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('abort-active-monitor-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const monitoring = handle.monitor({
      every: 'PT1H',
      input: 'check',
      until: () => false,
      signal: abortController.signal,
    });
    await generateStarted;
    abortController.abort();

    let caught: unknown;
    try {
      await monitoring;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
  });

  it('clears its process-local inter-tick timer and stops when aborted', async () => {
    const timerToken = Symbol('timer');
    const clearedTimers: unknown[] = [];
    let timerScheduled: (() => void) | undefined;
    const timerWasScheduled = new Promise<void>((resolve) => {
      timerScheduled = resolve;
    });
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('abort-local-monitor-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
      setTimeoutFunction: () => {
        timerScheduled?.();
        return timerToken;
      },
      clearTimeoutFunction: (timer) => {
        clearedTimers.push(timer);
      },
    });
    let doneEvents = 0;
    handle.emitter.addEventListener(SessionMonitorDoneEvent.type, () => {
      doneEvents += 1;
    });

    const monitoring = handle.monitor({
      every: 'PT1H',
      input: 'check',
      until: () => false,
      signal: abortController.signal,
    });
    await timerWasScheduled;
    abortController.abort();

    let caught: unknown;
    try {
      await monitoring;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTimers).toEqual([timerToken]);
    expect(doneEvents).toBe(1);
  });

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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
    } as unknown as RegistryAgnosticEngine;

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
        toolbox: createToolbox([]),
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
        toolbox: createToolbox([echoTool]),
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
