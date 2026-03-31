import { createTestToolbox } from 'armorer/test';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createMemoryKeyValueStore } from 'storage';

import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types';
import { withCacheMetrics } from './cache-metrics';

function makeContext(message = 'Hello'): GenerateContext {
  const conversation = new Conversation();
  conversation.appendUserMessage(message);
  return {
    conversation,
    step: 1,
    toolbox: createTestToolbox([]),
  };
}

function createTrackingGenerate(
  response: GenerateResponse = {
    content: 'response',
    toolCalls: [],
    usage: { prompt: 100, completion: 50, total: 150 },
  },
): GenerateFunction & { calls: GenerateContext[] } {
  const calls: GenerateContext[] = [];
  const fn = async (context: GenerateContext): Promise<GenerateResponse> => {
    calls.push(context);
    return response;
  };
  (fn as GenerateFunction & { calls: GenerateContext[] }).calls = calls;
  return fn as GenerateFunction & { calls: GenerateContext[] };
}

describe('withCacheMetrics', () => {
  let store: ReturnType<typeof createMemoryKeyValueStore>;

  beforeEach(() => {
    store = createMemoryKeyValueStore();
  });

  it('returns a generate function and metrics object', () => {
    const generate = createTrackingGenerate();
    const result = withCacheMetrics(generate, { store });

    expect(result.generate).toBeFunction();
    expect(result.metrics).toBeDefined();
    expect(result.metrics.hits).toBe(0);
    expect(result.metrics.misses).toBe(0);
  });

  it('tracks misses', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());

    expect(metrics.misses).toBe(1);
    expect(metrics.hits).toBe(0);
  });

  it('tracks hits', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
  });

  it('computes hitRate correctly', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    expect(metrics.hitRate).toBe(0.5);
  });

  it('returns 0 for hitRate when no calls have been made', () => {
    const generate = createTrackingGenerate();
    const { metrics } = withCacheMetrics(generate, { store });

    expect(metrics.hitRate).toBe(0);
  });

  it('tracks totalSavedTokens from cache hits', async () => {
    const generate = createTrackingGenerate({
      content: 'response',
      toolCalls: [],
      usage: { prompt: 100, completion: 50, total: 150 },
    });
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());
    await cached(makeContext());

    // 2 cache hits, each saving 100 + 50 = 150 tokens
    expect(metrics.totalSavedTokens).toBe(300);
  });

  it('handles responses with no usage data', async () => {
    const generate = createTrackingGenerate({
      content: 'response',
      toolCalls: [],
    });
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    expect(metrics.totalSavedTokens).toBe(0);
    expect(metrics.hits).toBe(1);
  });

  it('estimates saved cost when model is provided', async () => {
    const generate = createTrackingGenerate({
      content: 'response',
      toolCalls: [],
      usage: { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
    });
    const { generate: cached, metrics } = withCacheMetrics(generate, {
      store,
      model: 'gpt-4o',
    });

    await cached(makeContext());
    await cached(makeContext());

    // gpt-4o pricing: prompt $2.5/M, completion $10/M
    // Saved: $2.5 + $10 = $12.50
    expect(metrics.estimatedSavedCost).toBeCloseTo(12.5, 1);
  });

  it('returns 0 estimatedSavedCost when model is not provided', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    expect(metrics.estimatedSavedCost).toBe(0);
  });

  it('resets all counters', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, { store });

    await cached(makeContext());
    await cached(makeContext());

    metrics.reset();

    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(0);
    expect(metrics.hitRate).toBe(0);
    expect(metrics.totalSavedTokens).toBe(0);
    expect(metrics.estimatedSavedCost).toBe(0);
  });

  it('preserves the response from the underlying cached generate', async () => {
    const generate = createTrackingGenerate({
      content: 'hello',
      toolCalls: [],
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const { generate: cached } = withCacheMetrics(generate, { store });

    const result = await cached(makeContext());
    expect(result.content).toBe('hello');

    const cachedResult = await cached(makeContext());
    expect(cachedResult.content).toBe('hello');
  });

  it('forwards additional cache options', async () => {
    const generate = createTrackingGenerate();
    const { generate: cached, metrics } = withCacheMetrics(generate, {
      store,
      namespace: 'custom:',
    });

    await cached(makeContext());

    const keys = await store.list('custom:');
    expect(keys).toHaveLength(1);
    expect(metrics.misses).toBe(1);
  });
});
