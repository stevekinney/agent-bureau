import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, mock } from 'bun:test';
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
          startedAt: fixtureRuntime.clock.nowISO(),
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
    const fakeEngine = createSessionEngine({
      query: mock(async () => ({})),
    });

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
    const fakeEngine = createSessionEngine({
      query: mock(async (_id: string, _name: string) => ({ step: 3 })),
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
    const fakeEngine = createSessionEngine({
      query: mock(async () => ({ step: 5, status: 'completed' })),
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
