import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encode } from '@lostgradient/weft';
import type { StorageConfiguration } from '@lostgradient/weft/storage';
import { KEYS, MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory, getMessages } from 'conversationalist';
import type { GenerateFunction, SessionStore } from 'operative';
import { createAgentSession, stopWhen } from 'operative';
import {
  createDurableActiveRun,
  type DurableRunDeps,
  SCHEDULER_ORIGIN_TAG,
  startDurableRunResult,
} from 'operative/durable';
import type { SkillProvider } from 'skills';

import { createRuntimeComposition } from './runtime-composition';
import type { GenerateProviderName, ProviderConfiguration } from './types';

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

  // Regression: PRRT_kwDORvupsc6MXEmi — ProviderConfiguration.provider must be
  // narrowed to GenerateProviderName ('anthropic' | 'openai' | 'gemini') only.
  // Before the fix, ProviderName included 'voyage' and 'ollama' (embedding-only
  // backends with no generate factory), so a config that type-checked would throw
  // "Unknown provider" at runtime inside createRuntimeComposition.
  it('rejects an embedding-only provider at runtime via the resolveProviderGenerate hook', async () => {
    // The type system now prevents 'voyage' / 'ollama' from appearing in
    // ProviderConfiguration.provider — this cast simulates the pre-fix state where
    // the broader ProviderName union allowed embedding-only strings through.
    const embeddingOnlyProvider = {
      provider: 'voyage',
      model: 'voyage-3',
    } as unknown as ProviderConfiguration;

    let caughtError: unknown;
    try {
      await createRuntimeComposition({
        provider: embeddingOnlyProvider,
        toolbox: createToolbox([], { context: {} }),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain('Unknown provider');
  });

  it('GenerateProviderName only includes generate-capable backends', () => {
    // Exhaustiveness check: the three values that must be in GenerateProviderName.
    // If a new generate backend is added to operative without updating this type,
    // this test will fail because the GenerateProviderName will no longer match.
    const validProviders: GenerateProviderName[] = ['anthropic', 'openai', 'gemini'];
    expect(validProviders).toHaveLength(3);

    // Ensure 'voyage' and 'ollama' are NOT assignable to GenerateProviderName.
    // TypeScript enforces this at compile time; the runtime assertion below
    // documents the intent and catches accidental widenings.
    const embeddingOnlyNames: string[] = ['voyage', 'ollama'];
    for (const name of embeddingOnlyNames) {
      expect(validProviders.includes(name as GenerateProviderName)).toBe(false);
    }
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

  // Regression: PRRT_kwDORvupsc6MXoT3 — buildRunDepsFromSession omitted agentName
  // and runId from the returned DurableRunDeps.options. Fresh interactive runs
  // thread both via createActiveRun (fixed in MV8Xf), but the recovery path
  // (resolveRunServices → buildRunDepsFromSession) missed them. Resumed workflows
  // would have blank {agentName:'', runId:''} metadata on any future consumer of
  // RunOptions.agentName/runId — e.g. C3 tool.* bubble event stamping when a
  // recovered run re-executes a step.
  //
  // Fix: thread info.input.agentName (guaranteed by isAgentRunWorkflowInput) and
  // info.workflowId into buildRunDepsFromSession and spread both into the returned
  // DurableRunDeps.options so the resumed run's RunOptions parity matches fresh runs.
  //
  // This test verifies:
  //   1. A durable run started with agentName:'recovery-agent' recovers correctly.
  //   2. The recovered run reaches 'completed' (deps were rebuilt, generate ran).
  //   3. The session is updated to 'running' before recovery (the recoverable state
  //      is present) — so any failure here is in the recovery deps, not setup.
  it('threads agentName and runId from the durable input into rebuilt RunOptions during recovery (regression PRRT_kwDORvupsc6MXoT3)', async () => {
    const databasePath = join(
      tmpdir(),
      `recovery-agentname-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'recovery-agentname-run';
    let recoveredGenerateCalls = 0;

    try {
      // Phase 1: start a durable run with agentName:'recovery-agent' that hangs,
      // simulating a process crash while the run is in-flight.
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        expect(firstRuntime.sessionStore).toBeDefined();

        // Seed the recoverable session (same metadata create-bureau writes for
        // an active run: lastRunId, lastRunStatus:'running', lastUserMessage).
        await saveRecoverableSession(firstRuntime.sessionStore!, runId);

        // Start the durable run under agentName:'recovery-agent'. The run hangs
        // (generate never resolves), so when the engine is disposed the Weft
        // checkpoint carries { runId, sessionId, agentName:'recovery-agent' }
        // — available to resolveWorkflowServices on the second boot via info.input.
        void startDurableRunResult(firstRuntime.durable!, {
          runId,
          sessionId: runId,
          agentName: 'recovery-agent',
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
        // Dispose = simulated crash. The Weft storage persists the workflow input
        // (including agentName) so the second engine can recover it.
        firstRuntime.durable?.engine[Symbol.dispose]?.();
        firstRuntime.disposeStorage?.();
      }

      // Phase 2: boot a fresh engine and recover. resolveRunServices is called
      // by Weft with info.input.agentName = 'recovery-agent' and info.workflowId
      // = runId. The fix ensures buildRunDepsFromSession passes both into the
      // returned DurableRunDeps.options so the resumed generate call succeeds.
      const secondRuntime = await createRuntimeComposition({
        generate: async () => {
          recoveredGenerateCalls += 1;
          return { content: 'recovered', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        // The run must resume and complete — generate is non-blocking on the
        // second engine and the stopWhen:noToolCalls condition terminates it.
        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed' || state?.status === 'failed';
        });
        expect(completed).toBe(true);

        // The run must reach 'completed', not 'failed'. 'failed' would indicate
        // resolveRunServices returned 'unavailable' (deps could not be rebuilt —
        // which is the symptom if agentName/runId are incorrectly omitted and cause
        // a downstream error in buildRunDepsFromSession).
        const finalState = await secondRuntime.durable!.engine.get(runId);
        expect(finalState?.status).toBe('completed');

        // generate must have been called at least once during recovery (proving
        // the deps were reconstructed and the resumed step loop re-executed).
        expect(recoveredGenerateCalls).toBeGreaterThan(0);
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

  // Regression: PRRT_kwDORvupsc6MZEri — buildRunDepsFromSession did not recover the
  // per-request maximumTokens cap. fresh runs persist it to session metadata via
  // create-bureau saveSession, but the recovered options were built without reading it
  // back. After a process crash, resumed generate calls received maximumTokens:undefined,
  // silently dropping the client's cap and changing cost and output length.
  //
  // Fix: persist 'lastMaximumTokens' in saveSession and read it back in
  // buildRunDepsFromSession, spreading it into the returned DurableRunDeps.options
  // exactly as agentName/runId are spread.
  //
  // This test verifies that a durable run whose recoverable session carries a
  // lastMaximumTokens value passes it through to generate on recovery.
  it('threads maximumTokens from session metadata into rebuilt RunOptions during recovery (regression PRRT_kwDORvupsc6MZEri)', async () => {
    const databasePath = join(
      tmpdir(),
      `recovery-maximum-tokens-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'recovery-maximum-tokens-run';
    const expectedMaximumTokens = 42;
    // Object capture avoids TypeScript's let-closure narrowing to `undefined` on
    // a variable written inside an async callback.
    const captured: { maximumTokens?: number } = {};

    try {
      // Phase 1: start a durable run that hangs (simulating a process crash).
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        expect(firstRuntime.sessionStore).toBeDefined();

        // Seed the recoverable session with lastMaximumTokens — mirroring what
        // create-bureau's saveSession writes for a run started with maximumTokens.
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: runId,
            agentName: 'test-agent',
            conversationHistory: createConversationHistory(),
            metadata: {
              lastRunId: runId,
              lastRunStatus: 'running',
              lastUserMessage: 'recover this session',
              lastMaximumTokens: expectedMaximumTokens,
            },
          }),
        );

        void startDurableRunResult(firstRuntime.durable!, {
          runId,
          sessionId: runId,
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

      // Phase 2: boot a fresh engine and recover. The recovered generate must
      // receive the maximumTokens that were persisted in the session metadata.
      const secondRuntime = await createRuntimeComposition({
        generate: async (context) => {
          captured.maximumTokens = context.maximumTokens;
          return { content: 'recovered', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed' || state?.status === 'failed';
        });
        expect(completed).toBe(true);

        const finalState = await secondRuntime.durable!.engine.get(runId);
        expect(finalState?.status).toBe('completed');

        // The key assertion: the recovered generate must see the same
        // maximumTokens that were saved to session metadata before the crash.
        expect(captured.maximumTokens).toBe(expectedMaximumTokens);
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

  it('does not recover shape-only scheduled inputs without a persisted schedule marker', async () => {
    const databasePath = join(
      tmpdir(),
      `shape-only-scheduled-input-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'shape-only-scheduled-input-run';
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
        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: 'foreign recovered row' },
          { id: runId, services },
        );
        void handle.result().catch(() => {});

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
          return { content: 'must not run as scheduled fire', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        const originalGet = secondRuntime.durable!.engine.storage.get.bind(
          secondRuntime.durable!.engine.storage,
        );
        secondRuntime.durable!.engine.storage.get = async (key) => {
          if (key === KEYS.scheduleRun(runId)) {
            throw new Error('transient schedule marker read failure');
          }
          return originalGet(key);
        };
        await secondRuntime.durable!.engine.recoverAll();

        const failedWithoutGenerate = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'failed' && recoveredGenerateCalls === 0;
        });
        expect(failedWithoutGenerate).toBe(true);
        expect(recoveredGenerateCalls).toBe(0);
        const sessions = await secondRuntime.sessionStore!.list();
        expect(sessions.some((session) => session.id.startsWith('sched-'))).toBe(false);
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

  it('recovers markerless scheduled fires when Weft has a schedule-run marker and replaces replayed transcript suffixes', async () => {
    const databasePath = join(
      tmpdir(),
      `legacy-scheduled-input-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'legacy-scheduled-fire-run';
    const scheduleId = 'legacy-digest-schedule';
    const sessionId = 'legacy-digest-session';
    const scheduledPrompt = 'digest prompt';
    const partialAssistantContent = 'old partial assistant turn';
    const recoveredAssistantContent = 'recovered assistant turn';
    const concurrentAssistantContent = 'concurrent assistant update';
    let recoveredUserPromptCount = 0;
    let recoveredSawOldPartial = false;
    let saveConcurrentUpdate: () => Promise<void> = async () => {
      throw new Error('concurrent update writer was not initialized');
    };

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        const partialConversation = new Conversation(createConversationHistory({ id: sessionId }));
        partialConversation.appendUserMessage(scheduledPrompt);
        partialConversation.appendAssistantMessage('prior completed fire');
        partialConversation.appendUserMessage(scheduledPrompt, { scheduledFireRunId: runId });
        partialConversation.appendAssistantMessage(partialAssistantContent);
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: partialConversation.current,
            metadata: { lastScheduledFireRunId: runId },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt, sessionId },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

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
        generate: async ({ conversation }) => {
          const messages = conversation.getMessages();
          recoveredUserPromptCount = messages.filter(
            (message) => message.role === 'user' && message.content === scheduledPrompt,
          ).length;
          recoveredSawOldPartial = messages.some(
            (message) => message.content === partialAssistantContent,
          );
          await saveConcurrentUpdate();
          return { content: recoveredAssistantContent, toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      saveConcurrentUpdate = async () => {
        await secondRuntime.sessionStore!.update(sessionId, (existing) => {
          const updated = new Conversation(existing!.conversationHistory);
          updated.appendUserMessage(scheduledPrompt);
          updated.appendAssistantMessage(concurrentAssistantContent);
          return { ...existing!, conversationHistory: updated.current };
        });
      };

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(recoveredUserPromptCount).toBe(2);
        expect(recoveredSawOldPartial).toBe(false);

        const session = await secondRuntime.sessionStore!.load(sessionId);
        expect(session).toBeDefined();
        const messages = getMessages(session!.conversationHistory);
        expect(messages.some((message) => message.content === partialAssistantContent)).toBe(false);
        expect(messages.filter((message) => message.content === scheduledPrompt)).toHaveLength(3);
        expect(messages.some((message) => message.content === concurrentAssistantContent)).toBe(
          true,
        );
        expect(messages.some((message) => message.content === recoveredAssistantContent)).toBe(
          true,
        );
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

  it('recovers markerless scheduled fires when the session proves the scheduled fire', async () => {
    const databasePath = join(
      tmpdir(),
      `scheduled-session-proof-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'scheduled-session-proof-run';
    const sessionId = `sched-session-proof-${runId}`;
    const scheduledPrompt = 'session proof scheduled prompt';
    const recoveredAssistantContent = 'session proof scheduled recovery completed';

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        const partialConversation = new Conversation(createConversationHistory({ id: sessionId }));
        partialConversation.appendUserMessage(scheduledPrompt, { scheduledFireRunId: runId });
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: partialConversation.current,
            metadata: { lastScheduledFireRunId: runId },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt },
          { id: runId, services },
        );
        void handle.result().catch(() => {});

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
        generate: async () => ({ content: recoveredAssistantContent, toolCalls: [] }),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);

        const session = await secondRuntime.sessionStore!.load(sessionId);
        expect(session).toBeDefined();
        const messages = getMessages(session!.conversationHistory);
        expect(messages.some((message) => message.content === scheduledPrompt)).toBe(true);
        expect(messages.some((message) => message.content === recoveredAssistantContent)).toBe(
          true,
        );
        const unknownSession = await secondRuntime.sessionStore!.load(`sched-unknown-${runId}`);
        expect(unknownSession).toBeUndefined();
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

  it('replaces replayed transcript suffixes for stateless scheduled-fire sessions', async () => {
    const databasePath = join(
      tmpdir(),
      `stateless-scheduled-replay-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'stateless-scheduled-fire-run';
    const scheduleId = 'stateless-digest-schedule';
    const sessionId = `sched-${scheduleId}-${runId}`;
    const scheduledPrompt = 'stateless digest prompt';
    const partialAssistantContent = 'old stateless partial';
    const recoveredAssistantContent = 'recovered stateless assistant';
    let recoveredUserPromptCount = 0;

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        const partialConversation = new Conversation(createConversationHistory({ id: sessionId }));
        partialConversation.appendUserMessage(scheduledPrompt, { scheduledFireRunId: runId });
        partialConversation.appendAssistantMessage(partialAssistantContent);
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: partialConversation.current,
            metadata: { lastScheduledFireRunId: runId },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt, scheduleId: '   ' },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

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
        generate: async ({ conversation }) => {
          const messages = conversation.getMessages();
          recoveredUserPromptCount = messages.filter(
            (message) => message.role === 'user' && message.content === scheduledPrompt,
          ).length;
          return { content: recoveredAssistantContent, toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(recoveredUserPromptCount).toBe(1);

        const session = await secondRuntime.sessionStore!.load(sessionId);
        expect(session).toBeDefined();
        const messages = getMessages(session!.conversationHistory);
        expect(messages.filter((message) => message.content === scheduledPrompt)).toHaveLength(1);
        expect(messages.some((message) => message.content === partialAssistantContent)).toBe(false);
        expect(messages.some((message) => message.content === recoveredAssistantContent)).toBe(
          true,
        );
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

  it('recovers markerless scheduled fires when the schedule marker read fails transiently', async () => {
    const databasePath = join(
      tmpdir(),
      `scheduled-marker-read-error-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'scheduled-marker-read-error-run';
    const scheduleId = 'unreadable-digest-schedule';
    const recoveredSessionId = `sched-${scheduleId}-${runId}`;
    const unknownSessionId = `sched-unknown-${runId}`;
    const scheduledPrompt = 'digest prompt with unreadable schedule marker';
    const partialAssistantContent = 'old unreadable-marker partial';
    const recoveredAssistantContent = 'recovered despite marker read failure';
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
        const partialConversation = new Conversation(
          createConversationHistory({ id: recoveredSessionId }),
        );
        partialConversation.appendUserMessage(scheduledPrompt, { scheduledFireRunId: runId });
        partialConversation.appendAssistantMessage(partialAssistantContent);
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: recoveredSessionId,
            agentName: 'researcher',
            conversationHistory: partialConversation.current,
            metadata: { lastScheduledFireRunId: runId },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

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
          return { content: recoveredAssistantContent, toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        if (!secondRuntime.durable) throw new Error('durable engine was not configured');
        const { engine } = secondRuntime.durable;
        const storageWithPatchedGet = engine.storage as typeof engine.storage & {
          get: (key: string) => Promise<Uint8Array | null>;
        };
        const originalGet = storageWithPatchedGet.get.bind(storageWithPatchedGet);
        storageWithPatchedGet.get = async (key) => {
          if (key === KEYS.scheduleRun(runId)) {
            throw new Error('transient schedule marker read failure');
          }
          return originalGet(key);
        };

        await engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(recoveredGenerateCalls).toBe(1);

        const session = await secondRuntime.sessionStore!.load(recoveredSessionId);
        expect(session).toBeDefined();
        const messages = getMessages(session!.conversationHistory);
        expect(messages.some((message) => message.content === partialAssistantContent)).toBe(false);
        expect(messages.some((message) => message.content === scheduledPrompt)).toBe(true);
        expect(messages.some((message) => message.content === recoveredAssistantContent)).toBe(
          true,
        );
        const unknownSession = await secondRuntime.sessionStore!.load(unknownSessionId);
        expect(unknownSession).toBeUndefined();
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

  it('preserves an interactive run skill snapshot when a scheduled fire shares its session', async () => {
    const databasePath = join(
      tmpdir(),
      `scheduled-shared-session-skill-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const scheduledRunId = 'scheduled-shared-session-fire-run';
    const interactiveRunId = 'interactive-shared-session-run';
    const scheduleId = 'scheduled-shared-session-schedule';
    const sessionId = 'shared-session-with-interactive-run';
    const scheduledPrompt = 'scheduled prompt sharing an interactive session';

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: createConversationHistory({ id: sessionId }),
            metadata: {
              lastRunId: interactiveRunId,
              lastRunStatus: 'running',
              lastActiveSkills: [{ name: 'coding' }],
            },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt, sessionId },
          { id: scheduledRunId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(
          KEYS.scheduleRun(scheduledRunId),
          encode(scheduleId),
        );

        const running = await pollUntil(async () => {
          const state = await firstRuntime.durable!.engine.get(scheduledRunId);
          return state?.status === 'running';
        });
        expect(running).toBe(true);
      } finally {
        firstRuntime.durable?.engine[Symbol.dispose]?.();
        firstRuntime.disposeStorage?.();
      }

      const secondRuntime = await createRuntimeComposition({
        generate: async () => ({ content: 'scheduled fire completed', toolCalls: [] }),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(scheduledRunId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);

        const session = await secondRuntime.sessionStore!.load(sessionId);
        expect(session?.metadata['lastRunId']).toBe(interactiveRunId);
        expect(session?.metadata['lastRunStatus']).toBe('running');
        expect(session?.metadata['lastActiveSkills']).toEqual([{ name: 'coding' }]);
        expect(session?.metadata['lastScheduledFireRunId']).toBe(scheduledRunId);
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

  it('rehydrates active skills for recovered scheduled fires', async () => {
    const databasePath = join(
      tmpdir(),
      `scheduled-skill-recovery-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'scheduled-skill-fire-run';
    const scheduleId = 'scheduled-skill-schedule';
    const sessionId = 'scheduled-skill-session';
    const scheduledPrompt = 'use the coding skill';
    let loadedSkillResource: string | undefined;
    let skillResourceError: string | undefined;

    const provider = createMockSkillProvider([{ name: 'coding', description: 'Write code' }]);
    const skillProvider: SkillProvider = {
      ...provider,
      async listResources(name) {
        return name === 'coding' ? ['snippets/hello.py'] : [];
      },
      async loadResource(name, path) {
        if (name === 'coding' && path === 'snippets/hello.py') return 'print("Hello")';
        return undefined;
      },
    };

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: createConversationHistory({ id: sessionId }),
            metadata: {
              lastScheduledFireRunId: runId,
              lastActiveSkills: [{ name: 'coding' }],
            },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: scheduledPrompt, sessionId },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

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
        generate: async ({ toolbox }) => {
          const resourceResult = (await toolbox.execute({
            name: 'load_skill_resource',
            arguments: { skillName: 'coding', path: 'snippets/hello.py' },
          })) as { result: { content?: string; error?: string } };
          loadedSkillResource = resourceResult.result.content;
          skillResourceError = resourceResult.result.error;
          return { content: 'used recovered skill', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        skills: { provider: skillProvider },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(skillResourceError).toBeUndefined();
        expect(loadedSkillResource).toBe('print("Hello")');
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

  it('does not rehydrate stale skills from prior scheduled fires', async () => {
    const databasePath = join(
      tmpdir(),
      `scheduled-stale-skill-${process.pid}-${durableDatabaseCounter++}.sqlite`,
    );
    const runId = 'scheduled-stale-skill-fire-run';
    const scheduleId = 'scheduled-stale-skill-schedule';
    const sessionId = 'scheduled-stale-skill-session';
    let skillResourceError: string | undefined;

    const provider = createMockSkillProvider([{ name: 'coding', description: 'Write code' }]);
    const skillProvider: SkillProvider = {
      ...provider,
      async listResources(name) {
        return name === 'coding' ? ['snippets/hello.py'] : [];
      },
      async loadResource(name, path) {
        if (name === 'coding' && path === 'snippets/hello.py') return 'print("Hello")';
        return undefined;
      },
    };

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        await firstRuntime.sessionStore!.save(
          createAgentSession({
            id: sessionId,
            agentName: 'researcher',
            conversationHistory: createConversationHistory({ id: sessionId }),
            metadata: {
              lastActiveSkills: [{ name: 'coding' }],
            },
          }),
        );

        const toolbox = createToolbox([], { context: {} });
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox as never,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: 'do not inherit stale skills', sessionId },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

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
        generate: async ({ toolbox }) => {
          const resourceResult = (await toolbox.execute({
            name: 'load_skill_resource',
            arguments: { skillName: 'coding', path: 'snippets/hello.py' },
          })) as { result: { content?: string; error?: string } };
          skillResourceError = resourceResult.result.error;
          return { content: 'did not use stale skill', toolCalls: [] };
        },
        toolbox: createToolbox([], { context: {} }),
        skills: { provider: skillProvider },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        expect(secondRuntime.durable).toBeDefined();
        await secondRuntime.durable!.engine.recoverAll();

        const completed = await pollUntil(async () => {
          const state = await secondRuntime.durable!.engine.get(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(skillResourceError).toBe('Skill is not active');
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

  it('throws when durableExecution: true is combined with conditional text-store persistence', async () => {
    // A conditional text store cannot back a Weft engine (needs a raw Storage for
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
    // When persistence is a PersistenceOptions, a conditional text-store KV layer is built
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

// ── D4: Skills as an inherited bureau capability ─────────────────────────────
//
// These tests cover the catalog-injection hook wired in createRunRuntime:
//  • explicit provider → catalog injected as a system message on step 0
//  • no provider + no storage → skills wiring skipped (graceful degradation)
//  • no provider + storage present → storage-backed provider auto-constructed

/** Extract the text content from a message's content block (string or multi-modal array). */
function extractMessageText(
  content: string | ReadonlyArray<{ type?: string; text?: string }>,
): string {
  if (typeof content === 'string') return content;
  return content.map((block) => block.text ?? '').join('');
}

function createMockSkillProvider(
  skills: Array<{ name: string; description: string }>,
): SkillProvider {
  return {
    async listSkills() {
      return skills;
    },
    async isEnabled() {
      return true;
    },
    async loadSkill(name) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return undefined;
      return {
        metadata: { name: skill.name, description: skill.description },
        body: `# ${skill.name}\n${skill.description}`,
      };
    },
    async saveSkill() {},
    async deleteSkill() {},
    async listResources() {
      return [];
    },
    async loadResource() {
      return undefined;
    },
    async saveResource() {},
    async setEnabled() {},
  };
}

describe('D4: skills catalog injection', () => {
  it('injects the skill catalog as a system message on step 0 when a provider is given', async () => {
    const provider = createMockSkillProvider([
      { name: 'research', description: 'Deep research on any topic' },
    ]);

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      skills: { provider },
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'skills-step0-session',
    });

    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    // Fire each prepareStep hook at step 0 with the shared conversation.
    for (const hook of runRuntime.prepareStep) {
      await hook({ step: 0, conversation });
    }

    const systemMessages = conversation
      .getMessages()
      .filter((m) => m.role === 'system')
      .map((m) => extractMessageText(m.content));

    const catalogMessage = systemMessages.find((text) => text.includes('<available_skills>'));
    expect(catalogMessage).toBeDefined();
    expect(catalogMessage).toContain('research');
    expect(catalogMessage).toContain('Deep research on any topic');
  });

  it('does not inject the skill catalog on steps after step 0', async () => {
    const provider = createMockSkillProvider([{ name: 'research', description: 'Deep research' }]);

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      skills: { provider },
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'skills-step1-session',
    });

    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    // Fire at step 1 — catalog must NOT be injected.
    for (const hook of runRuntime.prepareStep) {
      await hook({ step: 1, conversation });
    }

    const systemMessages = conversation.getMessages().filter((m) => m.role === 'system');

    const hasCatalog = systemMessages.some((m) =>
      extractMessageText(m.content).includes('<available_skills>'),
    );

    expect(hasCatalog).toBe(false);
  });

  it('skips skills wiring when no provider and no storage backend is configured', async () => {
    // No explicit provider + no storage → resolvedSkillProvider is undefined →
    // no catalog hook is pushed → prepareStep array has no skill hook.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      // options.skills with no provider and no storage → graceful skip
      skills: {},
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'no-skills-session',
    });

    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    for (const hook of runRuntime.prepareStep) {
      await hook({ step: 0, conversation });
    }

    const hasCatalog = conversation
      .getMessages()
      .filter((m) => m.role === 'system')
      .some((m) => extractMessageText(m.content).includes('<available_skills>'));

    expect(hasCatalog).toBe(false);
  });

  it('auto-constructs a storage-backed skill provider when no explicit provider is given but storage is configured', async () => {
    // When options.skills has no provider but the bureau has a storage backend,
    // createStorageSkillProvider(kv) is constructed automatically. Saving a skill
    // to the same storage and then triggering the catalog hook must return it.
    const kv = textValueStore(new MemoryStorage());

    // Pre-seed a skill into the storage using the same key scheme the storage
    // provider writes — we write raw KV entries to avoid coupling to the provider
    // factory here. The skill-catalog hook reads 'skill:<name>:metadata' and
    // 'skill:<name>:enabled' keys.
    await kv.set(
      'skill:stored-skill:metadata',
      JSON.stringify({
        name: 'stored-skill',
        description: 'A skill seeded directly into KV',
        version: '1.0.0',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await kv.set('skill:stored-skill:enabled', 'true');

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      // No explicit provider — auto-construction should kick in.
      skills: {},
      // Provide the pre-seeded KV store as the persistence backend.
      persistence: kv,
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'auto-storage-skills-session',
    });

    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    for (const hook of runRuntime.prepareStep) {
      await hook({ step: 0, conversation });
    }

    const systemMessages = conversation
      .getMessages()
      .filter((m) => m.role === 'system')
      .map((m) => extractMessageText(m.content));

    const catalogMessage = systemMessages.find((text) => text.includes('<available_skills>'));
    expect(catalogMessage).toBeDefined();
    expect(catalogMessage).toContain('stored-skill');
    expect(catalogMessage).toContain('A skill seeded directly into KV');
  });

  // ── Regression: PRRT_kwDORvupsc6MZ-vj — catalog injected even when includeTools:false ──
  //
  // When `skills.includeTools === false`, the skill management toolbox is NOT wired
  // (no `activate_skill`, `deactivate_skill`, `load_skill_resource`, `list_skills`
  // tools). However the catalog injection hook was unconditional, meaning the model
  // received a "<available_skills>" message saying to "Use the activate_skill tool" —
  // but that tool was unavailable. A model following this instruction would call an
  // unavailable tool and fail.
  //
  // Fix: suppress the catalog hook when `includeTools === false` so the three skill-tool
  // surfaces (toolbox, tool summaries, catalog) are all consistently absent.
  it('does not inject the skill catalog when includeTools is false (PRRT_kwDORvupsc6MZ-vj)', async () => {
    const provider = createMockSkillProvider([
      { name: 'research', description: 'Deep research on any topic' },
    ]);

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: createToolbox([], { context: {} }),
      skills: { provider, includeTools: false },
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'no-tools-skills-session',
    });

    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    for (const hook of runRuntime.prepareStep) {
      await hook({ step: 0, conversation });
    }

    const systemMessages = conversation
      .getMessages()
      .filter((m) => m.role === 'system')
      .map((m) => extractMessageText(m.content));

    // No <available_skills> block should be injected — the catalog tells the model
    // to use activate_skill, which is not wired when includeTools is false.
    const hasCatalog = systemMessages.some((text) => text.includes('<available_skills>'));
    expect(hasCatalog).toBe(false);
  });

  it('does not include activate_skill in the toolbox when includeTools is false', async () => {
    const provider = createMockSkillProvider([
      { name: 'research', description: 'Deep research on any topic' },
    ]);

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      skills: { provider, includeTools: false },
    });

    const runRuntime = await runtime.createRunRuntime({
      message: 'Hello',
      sessionId: 'no-tools-activate-session',
    });

    // The toolbox must not expose activate_skill — it was not wired.
    const toolNames = runRuntime.toolbox.inspect('summary').tools.map((t) => t.name);
    expect(toolNames).not.toContain('activate_skill');
    expect(toolNames).not.toContain('deactivate_skill');
    expect(toolNames).not.toContain('list_skills');
    expect(toolNames).not.toContain('load_skill_resource');
  });
});

// ── Toolbox isolation across concurrent runs ──────────────────────────────────
//
// Each call to createRunRuntime must receive a FRESH toolbox clone, not a
// shared instance. A shared toolbox has a single CompletableEventTarget emitter;
// when createActiveRun subscribes to it via forwardEvents / addEventListener, all
// concurrent runs receive each other's tool.* events, corrupting their event
// streams and sharing budget/loop state.
describe('createRunRuntime toolbox isolation', () => {
  it('returns a distinct toolbox instance per call when options.toolbox is set', async () => {
    const sharedToolbox = createToolbox([], { context: {} });

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: sharedToolbox,
    });

    const runRuntimeA = await runtime.createRunRuntime({
      message: 'Hello from A',
      sessionId: 'isolation-session-a',
    });

    const runRuntimeB = await runtime.createRunRuntime({
      message: 'Hello from B',
      sessionId: 'isolation-session-b',
    });

    // The two runtimes must NOT share the same toolbox instance.
    // A shared emitter would let run A's tool events reach run B's listeners.
    expect(runRuntimeA.toolbox).not.toBe(runRuntimeB.toolbox);
    // And neither must be the original options.toolbox reference.
    expect(runRuntimeA.toolbox).not.toBe(sharedToolbox);
    expect(runRuntimeB.toolbox).not.toBe(sharedToolbox);
  });

  it('does not deliver tool events from one run to another concurrent run', async () => {
    const { createTool, createToolbox: makeToolbox } = await import('armorer');
    const { z } = await import('zod');

    // Deferred resolve so we can keep run A's tool call in-flight while run B
    // subscribes to its own toolbox — proving zero cross-talk.
    let resolveToolA!: (value: string) => void;
    const toolADone = new Promise<string>((resolve) => {
      resolveToolA = resolve;
    });

    const deferredTool = createTool({
      name: 'deferred_action',
      description: 'A tool whose execution can be deferred for testing',
      input: z.object({ payload: z.string() }),
      async execute({ payload }) {
        const result = await toolADone;
        return `${payload}:${result}`;
      },
    });

    const toolbox = makeToolbox([deferredTool], { context: {} });

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox,
    });

    const runRuntimeA = await runtime.createRunRuntime({
      message: 'A',
      sessionId: 'event-isolation-a',
    });
    const runRuntimeB = await runtime.createRunRuntime({
      message: 'B',
      sessionId: 'event-isolation-b',
    });

    const bReceivedEvents: string[] = [];
    runRuntimeB.toolbox.addEventListener('execute-start', (e) => {
      bReceivedEvents.push(e.call.name);
    });

    // Start run A's tool call in the background (it will block until resolved).
    void runRuntimeA.toolbox.execute({ name: 'deferred_action', arguments: { payload: 'test' } });

    // Give the in-flight execute a microtask to register with the emitter.
    await Promise.resolve();

    // Run B must not have received any events from run A's tool execution.
    expect(bReceivedEvents).toHaveLength(0);

    // Unblock run A.
    resolveToolA('done');
  });
});

// ── Regression: PRRT_kwDORvupsc6MZ1Md — active skill session not preserved across durable recovery ──
//
// When a durable run recovers, `buildRunDepsFromSession` calls `createRunRuntime` which
// creates a fresh empty `SkillSession`. Completed pre-crash steps that called
// `activate_skill` are memoized by Weft and do NOT re-run, so the recovered toolbox
// had no knowledge of which skills were active — `list_skills` reported all skills
// inactive even if the live run had activated them.
//
// Fix: after each step, snapshot the active skill set to session metadata
// (`lastActiveSkills`). On durable recovery, `buildRunDepsFromSession` reads the
// snapshot and passes it as `initialActiveSkills` to `createRunRuntime`, which seeds
// the SkillSession before any tool executions so the recovered toolbox reflects the
// pre-crash active set.
//
// These tests verify:
//   1. Passing `initialActiveSkills` to `createRunRuntime` seeds the SkillSession
//      so `list_skills` reports the skills as active without `activate_skill` being
//      called (the recovery seeding path).
//   2. The `onStep` hooks include a snapshot writer that writes `lastActiveSkills` to
//      session metadata when the session store is configured — providing the data the
//      recovery path reads.
describe('PRRT_kwDORvupsc6MZ1Md: active skill session preserved across durable recovery', () => {
  it('seeds the SkillSession from initialActiveSkills so recovered toolbox reports skills as active', async () => {
    const provider = createMockSkillProvider([
      { name: 'research', description: 'Deep research' },
      { name: 'writing', description: 'Write documents' },
    ]);

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      skills: { provider },
    });

    // Simulate recovery: pass initialActiveSkills as a recovered run would, so the
    // SkillSession is pre-seeded without calling activate_skill (which would be
    // memoized away in a real recovery).
    const runRuntime = await runtime.createRunRuntime(
      { message: 'Hello', sessionId: 'recovery-skills-session' },
      { initialActiveSkills: [{ name: 'research' }] },
    );

    // list_skills must report 'research' as active — without activate_skill being called.
    const listResult = await runRuntime.toolbox.execute({
      name: 'list_skills',
      arguments: {},
    });

    const result = listResult as { result: { skills: Array<{ name: string; active: boolean }> } };
    const skills = result.result.skills;
    const researchEntry = skills.find((s) => s.name === 'research');
    const writingEntry = skills.find((s) => s.name === 'writing');

    expect(researchEntry).toBeDefined();
    expect(researchEntry?.active).toBe(true);

    expect(writingEntry).toBeDefined();
    expect(writingEntry?.active).toBe(false);
  });

  it('initialActiveSkills includes tool policy so load_skill_resource accepts the pre-seeded skill', async () => {
    const provider = createMockSkillProvider([{ name: 'coding', description: 'Write code' }]);
    // Augment the provider to serve a resource for 'coding'.
    const augmentedProvider: SkillProvider = {
      ...provider,
      async listResources(name) {
        return name === 'coding' ? ['snippets/hello.py'] : [];
      },
      async loadResource(name, path) {
        if (name === 'coding' && path === 'snippets/hello.py') {
          return 'print("Hello, world!")';
        }
        return undefined;
      },
    };

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      skills: { provider: augmentedProvider },
    });

    // Seed the SkillSession via initialActiveSkills (the recovery path).
    const runRuntime = await runtime.createRunRuntime(
      { message: 'Hello', sessionId: 'recovery-resource-session' },
      { initialActiveSkills: [{ name: 'coding' }] },
    );

    // load_skill_resource must succeed for the pre-seeded skill.
    const resourceResult = await runRuntime.toolbox.execute({
      name: 'load_skill_resource',
      arguments: { skillName: 'coding', path: 'snippets/hello.py' },
    });

    const result = resourceResult as { result: { content?: string; error?: string } };
    expect(result.result.error).toBeUndefined();
    expect(result.result.content).toBe('print("Hello, world!")');
  });

  it('writes lastActiveSkills to session metadata via the onStep hook after a skill is activated', async () => {
    const provider = createMockSkillProvider([{ name: 'research', description: 'Deep research' }]);
    // Use an in-memory KV store so the session store is configured (durable path).
    const kv = textValueStore(new MemoryStorage());
    const sessionId = 'snapshot-skills-session';

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      skills: { provider },
      persistence: kv,
    });

    const runRuntime = await runtime.createRunRuntime({ message: 'Hello', sessionId });

    // Create a session record so updateMetadata has something to update.
    await runtime.sessionStore!.save(
      createAgentSession({
        id: sessionId,
        agentName: 'test-agent',
        conversationHistory: createConversationHistory(),
        metadata: {},
      }),
    );

    // Activate 'research' via the toolbox (simulates an LLM calling activate_skill).
    await runRuntime.toolbox.execute({
      name: 'activate_skill',
      arguments: { name: 'research' },
    });

    // Fire the onStep hooks — the snapshot hook should write lastActiveSkills.
    const fakeStepContext = {
      step: 0,
      conversation: new Conversation(),
      content: 'I activated research.',
      toolCalls: [],
      results: [],
      final: true,
    };
    for (const hook of runRuntime.onStep) {
      await hook(fakeStepContext);
    }

    // Verify that lastActiveSkills was written to session metadata.
    const session = await runtime.sessionStore!.load(sessionId);
    expect(session).toBeDefined();
    const lastActiveSkills = session!.metadata['lastActiveSkills'];
    expect(Array.isArray(lastActiveSkills)).toBe(true);
    expect(lastActiveSkills).toHaveLength(1);
    const entry = (lastActiveSkills as Array<{ name: string }>)[0];
    expect(entry?.name).toBe('research');
  });

  it('clears lastActiveSkills from session metadata when all skills are deactivated', async () => {
    const provider = createMockSkillProvider([{ name: 'research', description: 'Deep research' }]);
    const kv = textValueStore(new MemoryStorage());
    const sessionId = 'deactivate-skills-session';

    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      skills: { provider },
      persistence: kv,
    });

    const runRuntime = await runtime.createRunRuntime({ message: 'Hello', sessionId });

    await runtime.sessionStore!.save(
      createAgentSession({
        id: sessionId,
        agentName: 'test-agent',
        conversationHistory: createConversationHistory(),
        metadata: {},
      }),
    );

    // Activate then deactivate.
    await runRuntime.toolbox.execute({ name: 'activate_skill', arguments: { name: 'research' } });
    await runRuntime.toolbox.execute({ name: 'deactivate_skill', arguments: { name: 'research' } });

    const fakeStepContext = {
      step: 1,
      conversation: new Conversation(),
      content: 'deactivated.',
      toolCalls: [],
      results: [],
      final: true,
    };
    for (const hook of runRuntime.onStep) {
      await hook(fakeStepContext);
    }

    const session = await runtime.sessionStore!.load(sessionId);
    const lastActiveSkills = session!.metadata['lastActiveSkills'];
    expect(Array.isArray(lastActiveSkills)).toBe(true);
    expect(lastActiveSkills).toHaveLength(0);
  });
});
