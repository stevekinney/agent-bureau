import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { GenerateFunction } from 'operative';
import { stopWhen } from 'operative';
import { createDurableRun } from 'operative/durable';

import { createRuntimeComposition } from './runtime-composition';
import type { ProviderConfiguration } from './types';

// Weft's inline launch queue defers each workflow start onto a `setTimeout(0)`
// macrotask. Under `bun test`, a prior test that leaves an unsettled async tail
// (the cost-aware `generate` path here) can starve that deferred launch, so a
// later durable run's `handle.result()` never resolves and the test times out.
// The run is correct — it completes start-to-finish in a plain `bun run`
// process; this is purely a per-test scheduling artifact. Yielding one macrotask
// between tests drains the timer queue so each test starts clean.
// TODO(weft-integration): an `Engine`-level "drain pending launches on dispose"
//   would let us drop this; tracked alongside the recovery seams.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      // PRODUCT'S composition built — not a hand-assembled Engine.create.
      const result = await createDurableRun(runtime.durable!, {
        runId: 'composition-run',
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

      expect(result.runId).toBe('composition-run');
      expect(result.steps).toBe(1);
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
});
