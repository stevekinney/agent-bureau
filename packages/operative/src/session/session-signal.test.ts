import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle, NoDurableEngineError, NoRunningRunError } from './session-handle';
import { createInstantGenerate, fixtureRuntime } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = createSessionEngine({
      signal: async () => {},
    });

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

    const fakeEngine = createSessionEngine({
      signal: async (id: string, name: string, payload: unknown) => {
        signalCalls.push({ id, name, payload });
      },
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
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

    const fakeEngine = createSessionEngine({
      signal: async (id: string, name: string, payload: unknown) => {
        signalCalls.push({ id, name, payload });
      },
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
        {
          runId: 'signal-newest-running:1',
          sequence: 1,
          status: 'completed',
          startedAt: fixtureRuntime.clock.nowISO(),
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
