import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageConfiguration } from '@lostgradient/weft/storage';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { GenerateFunction, SessionStore } from 'operative';
import { createAgentSession, stopWhen } from 'operative';
import {
  createDurableActiveRun,
  SCHEDULER_ORIGIN_TAG,
  startDurableRunResult,
} from 'operative/durable';

import { createRuntimeComposition } from './runtime-composition';
import type { ProviderConfiguration } from './types';

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI). 0.3.0's dispose-drain does not replace this flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

function createGenerateForProvider(provider: ProviderConfiguration): GenerateFunction {
  return async () => {
    const total = provider.model === 'expensive-model' ? 60 : 10;

    return {
      content: provider.model,
      toolCalls: [],
      usage: {
        prompt: 0,
        completion: total,
        total,
      },
    };
  };
}

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 20): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await yieldToPortableEventLoop();
  }
  return false;
}

async function saveRecoverableSession(sessionStore: SessionStore, runId: string): Promise<void> {
  await sessionStore.save(
    createAgentSession({
      id: runId,
      agentName: 'test-agent',
      conversationHistory: createConversationHistory(),
      metadata: {
        lastRunId: runId,
        lastRunStatus: 'running',
        lastUserMessage: 'recover this session if it is not scheduler-origin',
      },
    }),
  );
}

describe('createRuntimeComposition', () => {
  it('does not create a stream event target for custom generate functions', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'custom', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'session-custom',
    });

    expect(runRuntime.streamEventTarget).toBeUndefined();
  });

  it('reuses cost-aware routing budget across separate run runtimes', async () => {
    const runtime = await createRuntimeComposition(
      {
        providers: [
          {
            name: 'cheap',
            provider: { provider: 'openai', model: 'cheap-model' },
          },
          {
            name: 'expensive',
            provider: { provider: 'openai', model: 'expensive-model' },
          },
        ],
        routing: {
          type: 'cost-aware',
          cheap: 'cheap',
          expensive: 'expensive',
          budget: 100,
          thresholdRatio: 0.5,
        },
        toolbox: createToolbox([], { context: {} }),
      },
      {
        resolveProviderGenerate(provider) {
          return createGenerateForProvider(provider);
        },
      },
    );

    const firstRunRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'session-1',
    });
    const firstConversation = new Conversation();
    firstConversation.appendUserMessage('Hello');

    const firstResult = await firstRunRuntime.generate({
      conversation: firstConversation,
      step: 0,
      toolbox: firstRunRuntime.toolbox,
    });

    const secondRunRuntime = await runtime.createRunRuntime({
      message: 'Hello again',
      sessionId: 'session-2',
    });
    const secondConversation = new Conversation();
    secondConversation.appendUserMessage('Hello again');

    const secondResult = await secondRunRuntime.generate({
      conversation: secondConversation,
      step: 0,
      toolbox: secondRunRuntime.toolbox,
    });

    expect(firstResult.content).toBe('expensive-model');
    expect(secondResult.content).toBe('cheap-model');
  });

  it('reuses non-streaming provider pipelines across separate run runtimes', async () => {
    let resolveProviderGenerateCalls = 0;

    const runtime = await createRuntimeComposition(
      {
        providers: [
          {
            name: 'primary',
            provider: { provider: 'openai', model: 'cheap-model' },
          },
          {
            name: 'secondary',
            provider: { provider: 'anthropic', model: 'expensive-model' },
          },
        ],
        streaming: { enabled: false },
        toolbox: createToolbox([], { context: {} }),
      },
      {
        resolveProviderGenerate(provider) {
          resolveProviderGenerateCalls += 1;
          return createGenerateForProvider(provider);
        },
      },
    );

    const firstRunRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'session-1',
    });
    const secondRunRuntime = await runtime.createRunRuntime({
      message: 'Hello again',
      sessionId: 'session-2',
    });

    expect(firstRunRuntime.generate).toBe(secondRunRuntime.generate);
    expect(resolveProviderGenerateCalls).toBe(2);
  });
});

let durableDatabaseCounter = 0;

describe('createRuntimeComposition durable execution', () => {
  it('does not build a durable engine by default', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'memory' },
    });
    // Off by default: no durableExecution flag → no engine.
    expect(runtime.durable).toBeUndefined();
  });

  it('does not build a durable engine when the flag is set without storage', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      durableExecution: true,
    });
    // A durable engine needs a persistent backend; no storage → no engine.
    expect(runtime.durable).toBeUndefined();
  });

  it('wires observability onto the durable engine when BureauOptions.observability is set', async () => {
    // observability:true threads through to createRunEngine, which attaches the
    // interceptor and surfaces the metrics + dispose handle on runtime.durable.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'memory' },
      durableExecution: true,
      observability: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
      expect(runtime.durable?.observability).toBeDefined();
      expect(typeof runtime.durable?.observability?.metrics.snapshot).toBe('function');
    } finally {
      runtime.durable?.observability?.dispose();
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('leaves observability undefined on the durable engine when not requested', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
      expect(runtime.durable?.observability).toBeUndefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('threads durableGuardrails (history + checkpoint warning) into the durable engine', async () => {
    // The composition forwards BureauOptions.durableGuardrails into createRunEngine.
    // A generous history limit leaves a normal run intact; the engine still builds
    // and the onCheckpointSizeWarning subscriber is accepted without error.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'memory' },
      durableExecution: true,
      durableGuardrails: {
        history: { maxEvents: 10_000 },
        checkpointSizeWarningThreshold: 128_000,
        onCheckpointSizeWarning: () => {},
      },
    });
    try {
      expect(runtime.durable).toBeDefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('builds a durable engine BY DEFAULT for a persistent (sqlite) backend with no flag', async () => {
    // The default-on contract: a persistent storage backend and NO explicit
    // `durableExecution` flag resolves to durable-on, because that is the only
    // place a crash can actually resume. This is the headline behavior — a
    // normal bureau with sqlite storage gets durable runs without opting in.
    const databasePath = join(
      tmpdir(),
      `default-on-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    try {
      const runtime = await createRuntimeComposition({
        generate: async () => ({ content: 'x', toolCalls: [] }),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
      });
      expect(runtime.durable).toBeDefined();
      runtime.durable?.engine[Symbol.dispose]?.();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('stays OFF when durableExecution is explicitly false even for a persistent backend', async () => {
    // The explicit `false` override: a persistent backend would default to
    // durable-on, but a caller can force the in-memory loop back.
    const databasePath = join(
      tmpdir(),
      `explicit-off-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    try {
      const runtime = await createRuntimeComposition({
        generate: async () => ({ content: 'x', toolCalls: [] }),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: false,
      });
      expect(runtime.durable).toBeUndefined();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('throws when durableExecution: true is combined with a custom persistence value', async () => {
    // `persistence` shadows `storage`, so no raw backend is resolved and a
    // durable engine cannot share its backend with the session store. Honoring
    // `durableExecution: true` silently would ship an engine that looks durable
    // but can never recover (the boot reconstructor scans the SESSION store).
    // The contradiction must fail loud at composition, not silently no-op.
    const error = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'sqlite', path: join(tmpdir(), 'never-created.sqlite') },
      durableExecution: true,
      persistence: textValueStore(new MemoryStorage()),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/durableExecution: true is incompatible/);
  });

  it('stays OFF (no engine) for sqlite + a custom persistence when durableExecution is unset', async () => {
    // The silent-downgrade guard: with NO explicit flag, a custom `persistence`
    // shadows `storage`, so `wantsDurable` resolves to FALSE — the honest
    // default-off, not a wanted-but-unbuildable engine. (A persistence override
    // means the caller is driving their own KV layer; durable-on would need the
    // engine and sessions on one backend, which this config does not provide.)
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'sqlite', path: join(tmpdir(), 'unset-persistence.sqlite') },
      persistence: textValueStore(new MemoryStorage()),
    });
    expect(runtime.durable).toBeUndefined();
  });

  it('builds a durable engine through the composition path and runs an agent durably', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'composed', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    expect(runtime.durable).toBeDefined();

    try {
      // The integration gate: drive a durable run through the engine the
      // PRODUCT'S composition built — not a hand-assembled Engine.create. Uses
      // the same `createDurableActiveRun` entry the gateway routes through.
      const activeRun = createDurableActiveRun(runtime.durable!, {
        runId: 'composition-run',
        sessionId: 'composition-run',
        prompt: 'Hello',
        options: {
          generate: async () => ({ content: 'durable result', toolCalls: [] }),
          toolbox: createToolbox([], { context: {} }) as never,
          conversation: createConversationHistory(),
          // The durable driver honors RunOptions.stopWhen exactly like the
          // in-memory loop: settle on the first turn with no tool calls.
          stopWhen: stopWhen.noToolCalls(),
        },
      });
      const result = await activeRun.result;

      expect(result.steps).toHaveLength(1);
      expect(result.content).toBe('durable result');
      expect(result.finishReason).toBe('stop-condition');

      // The run is durably checkpointed through the composition's store.
      const checkpoint = await runtime.durable!.checkpointStore.loadCheckpoint('composition-run');
      expect(checkpoint.cursor.step).toBe(1);
      expect(checkpoint.steps).toHaveLength(1);
    } finally {
      runtime.durable!.engine[Symbol.dispose]();
    }
  });

  it('uses Weft launch tags instead of scheduler id heuristics during service resolution', async () => {
    const databasePath = join(
      tmpdir(),
      `resolver-launch-tags-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'tagged-scheduler-origin-without-prefix';
    let recoveredGenerateCalls = 0;

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        expect(firstRuntime.sessionStore).toBeDefined();
        await saveRecoverableSession(firstRuntime.sessionStore!, runId);

        void startDurableRunResult(firstRuntime.durable!, {
          runId,
          sessionId: runId,
          tags: [SCHEDULER_ORIGIN_TAG],
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: createToolbox([], { context: {} }) as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        }).catch(() => {});

        const running = await pollUntil(async () => {
          const state = await firstRuntime.durable!.engine.get(runId);
          return state?.status === 'running';
        });
        expect(running).toBe(true);
      } finally {
        firstRuntime.durable?.engine[Symbol.dispose]?.();
        firstRuntime.disposeStorage?.();
      }

      const secondRuntime = await createRuntimeComposition({
        generate: async () => {
          recoveredGenerateCalls += 1;
          return { content: 'should not recover scheduler-origin runs', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();
        const failedWithoutReplayingSession = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'failed' && recoveredGenerateCalls === 0;
        });
        expect(failedWithoutReplayingSession).toBe(true);
        expect(recoveredGenerateCalls).toBe(0);
      } finally {
        secondRuntime.durable?.engine[Symbol.dispose]?.();
        secondRuntime.disposeStorage?.();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('createRuntimeComposition PersistenceOptions form', () => {
  // D1 acceptance: the options-object form { store, history?, observability?, onLog? }
  // builds the durable engine with the same result as the legacy storage/durableExecution form.

  it('builds a durable engine from PersistenceOptions with a memory store', async () => {
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: { store: { type: 'memory' } },
      // PersistenceOptions with a memory store: durableExecution defaults to OFF
      // for memory (checkpoints are lost with the process), so explicitly enable.
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('builds a durable engine from a bare StorageConfiguration in persistence', async () => {
    // Bare StorageConfiguration is shorthand for PersistenceOptions { store: config }.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: { type: 'memory' } as StorageConfiguration,
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('threads history from PersistenceOptions into the durable engine', async () => {
    // D1: history is exposed in the options-object form alongside store.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: {
        store: { type: 'memory' },
        history: { maxEvents: 10_000 },
      },
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('threads observability from PersistenceOptions into the durable engine', async () => {
    // D1: observability is exposed in the options-object form alongside store.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: {
        store: { type: 'memory' },
        observability: true,
      },
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
      expect(runtime.durable?.observability).toBeDefined();
      expect(typeof runtime.durable?.observability?.metrics.snapshot).toBe('function');
    } finally {
      runtime.durable?.observability?.dispose();
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('threads onLog from PersistenceOptions into the durable engine', async () => {
    // D1: onLog is exposed in the options-object form alongside store.
    const logRecords: unknown[] = [];
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: {
        store: { type: 'memory' },
        onLog: (record) => logRecords.push(record),
      },
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
      // The onLog wiring is accepted without error; actual log records only appear
      // when a workflow emits ctx.log() calls — not verified here.
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('PersistenceOptions observability takes precedence over top-level observability', async () => {
    // When both PersistenceOptions.observability and BureauOptions.observability are
    // set, PersistenceOptions wins (it co-locates the knob with the store).
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: {
        store: { type: 'memory' },
        observability: true,
      },
      observability: false, // should be overridden by PersistenceOptions.observability
      durableExecution: true,
    });
    try {
      expect(runtime.durable).toBeDefined();
      // PersistenceOptions.observability: true wins → observability handle is present.
      expect(runtime.durable?.observability).toBeDefined();
    } finally {
      runtime.durable?.observability?.dispose();
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });

  it('throws when durableExecution: true is combined with a TextValueStore persistence', async () => {
    // A TextValueStore cannot back a Weft engine (needs a raw Storage for
    // checkpointing). Honoring the contradiction silently would ship an engine
    // that looks durable but can never recover.
    const error = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      durableExecution: true,
      persistence: textValueStore(new MemoryStorage()),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/durableExecution: true is incompatible/);
  });

  it('creates a KV session store from PersistenceOptions store', async () => {
    // When persistence is a PersistenceOptions, a TextValueStore KV layer is built
    // over the raw Storage, enabling session persistence.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'x', toolCalls: [] }),
      persistence: { store: { type: 'memory' } },
      durableExecution: true,
    });
    try {
      // The KV view is available for session/cache use.
      expect(runtime.kv).toBeDefined();
      // The session store is built over the KV view.
      expect(runtime.sessionStore).toBeDefined();
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });
});
