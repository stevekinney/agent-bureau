import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle, NoDurableEngineError, NoRunningRunError } from './session-handle';
import {
  createInstantGenerate,
  createTestRunOptions,
  createUpdateGate,
  fixtureRuntime,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
    const fakeEngine = createSessionEngine({
      update: mock(async (_id: string, _name: string, _payload: unknown) => ({ ok: true })),
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
    const fakeEngine = createSessionEngine({
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
    });

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
      toolbox: createToolbox([]),
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
    const fakeEngine = createSessionEngine({
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
    });

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
          startedAt: fixtureRuntime.clock.nowISO(),
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
