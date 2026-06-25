import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import type { Toolbox } from 'armorer';
import { createToolbox } from 'armorer';
import { describe, expect, it, mock } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';

import { createAgentSession } from '../agent-session';
import type { AnyRunEngine } from '../durable/create-run-engine';
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
} from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import {
  createSessionHandle,
  deriveRunId,
  NoDurableEngineError,
  NoRunningRunError,
} from './session-handle';

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

  it('updates the session conversation history after each run', async () => {
    const { handle, store } = createSessionHandleFixture();

    await handle.run('hello world').result();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const session = await store.load(handle.id);
    // The conversation history should contain at least the user message.
    expect(session!.conversationHistory).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// recover() — re-attach to the in-flight run
// ---------------------------------------------------------------------------

describe('session.recover()', () => {
  it('returns null when no run is in flight', () => {
    const { handle } = createSessionHandleFixture();
    expect(handle.recover()).toBeNull();
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
    const recovered = blockingHandle.recover();

    // The handle is set synchronously in run().
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

    expect(handle.recover()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancel() — abort the in-flight run
// ---------------------------------------------------------------------------

describe('session.cancel()', () => {
  it('aborts the current run and clears the in-flight reference', async () => {
    let abortCalled = false;
    let resolveGenerate: (() => void) | undefined;

    const blockingGenerate: GenerateFunction = (_ctx) => {
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
        if (_ctx.signal) {
          _ctx.signal.addEventListener('abort', () => {
            abortCalled = true;
          });
        }
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

    // Yield to let the generate function be called and attach the abort listener.
    await Promise.resolve();
    await Promise.resolve();

    expect(h.recover()).not.toBeNull();
    await h.cancel();

    // The abort signal should have fired.
    expect(abortCalled).toBe(true);
    // The handle should be cleared.
    expect(h.recover()).toBeNull();

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
    const recovered = h.recover();
    expect(recovered).toBe(run);

    // A "deliberate stop" — cancel() aborts the run.
    await h.cancel();

    // After cancel, recover() returns null.
    expect(h.recover()).toBeNull();

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
  it('recover() dispatches SessionRecoverEvent on the emitter', () => {
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
    h.recover();

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
