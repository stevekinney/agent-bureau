import { describe, expect, it } from 'bun:test';

import type { GenerateContext } from '../types.ts';
import { withRoutingMetrics } from './routing-metrics.ts';
import type { ModelRoute } from './types.ts';

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: {
      current: { ids: [], messages: {} },
    } as unknown as GenerateContext['conversation'],
    step: 0,
    toolbox: { tools: () => [] } as unknown as GenerateContext['toolbox'],
    ...overrides,
  };
}

function makeRoute(name: string, content: string, costPerMillionTokens?: number): ModelRoute {
  return {
    name,
    generate: async () => ({
      content,
      toolCalls: [],
      usage: { prompt: 100, completion: 50, total: 150 },
    }),
    costPerMillionTokens,
  };
}

describe('withRoutingMetrics', () => {
  it('returns a generate function and metrics handle', () => {
    const result = withRoutingMetrics({
      routes: [makeRoute('fast', 'fast-response')],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    expect(result.generate).toBeFunction();
    expect(result.metrics).toBeDefined();
    expect(result.metrics.routeCounts).toBeInstanceOf(Map);
    expect(result.metrics.routeCosts).toBeInstanceOf(Map);
    expect(result.metrics.routeLatencies).toBeInstanceOf(Map);
  });

  it('tracks route counts per route', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [makeRoute('fast', 'fast'), makeRoute('smart', 'smart')],
      strategy: (ctx) => ({
        route: ctx.step === 0 ? 'fast' : 'smart',
        reason: 'test',
      }),
      fallback: 'fast',
    });

    await generate(makeContext({ step: 0 }));
    await generate(makeContext({ step: 1 }));
    await generate(makeContext({ step: 1 }));

    expect(metrics.routeCounts.get('fast')).toBe(1);
    expect(metrics.routeCounts.get('smart')).toBe(2);
  });

  it('tracks token costs from response usage', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [
        {
          name: 'fast',
          generate: async () => ({
            content: 'ok',
            toolCalls: [],
            usage: { prompt: 100, completion: 50, total: 150 },
          }),
          costPerMillionTokens: 1.0,
        },
      ],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    await generate(makeContext());
    await generate(makeContext());

    // Each call: 150 tokens * (1.0 / 1_000_000) = 0.00015
    // Two calls: 0.0003
    const cost = metrics.routeCosts.get('fast')!;
    expect(cost).toBeCloseTo(0.0003, 6);
  });

  it('handles routes without costPerMillionTokens', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [makeRoute('fast', 'ok')],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    await generate(makeContext());

    // No cost tracking when costPerMillionTokens is not set
    expect(metrics.routeCosts.get('fast')).toBe(0);
  });

  it('tracks latencies per route', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [makeRoute('fast', 'ok')],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    await generate(makeContext());
    await generate(makeContext());

    const latencies = metrics.routeLatencies.get('fast')!;
    expect(latencies).toHaveLength(2);
    expect(latencies[0]).toBeGreaterThanOrEqual(0);
    expect(latencies[1]).toBeGreaterThanOrEqual(0);
  });

  it('resets all metrics', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [makeRoute('fast', 'ok', 1.0)],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    await generate(makeContext());
    expect(metrics.routeCounts.get('fast')).toBe(1);

    metrics.reset();

    expect(metrics.routeCounts.size).toBe(0);
    expect(metrics.routeCosts.size).toBe(0);
    expect(metrics.routeLatencies.size).toBe(0);
  });

  it('handles generate responses without usage data', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [
        {
          name: 'fast',
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          costPerMillionTokens: 1.0,
        },
      ],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    await generate(makeContext());

    expect(metrics.routeCounts.get('fast')).toBe(1);
    expect(metrics.routeCosts.get('fast')).toBe(0);
  });

  it('propagates errors from the underlying generate function', async () => {
    const { generate } = withRoutingMetrics({
      routes: [
        {
          name: 'failing',
          generate: async () => {
            throw new Error('API error');
          },
        },
      ],
      strategy: () => ({ route: 'failing', reason: 'test' }),
      fallback: 'failing',
    });

    try {
      await generate(makeContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('API error');
    }
  });

  it('still records latency when generate throws', async () => {
    const { generate, metrics } = withRoutingMetrics({
      routes: [
        {
          name: 'failing',
          generate: async () => {
            throw new Error('API error');
          },
        },
      ],
      strategy: () => ({ route: 'failing', reason: 'test' }),
      fallback: 'failing',
    });

    try {
      await generate(makeContext());
    } catch {
      // expected
    }

    // Count should not be incremented on error (only successful calls)
    expect(metrics.routeCounts.get('failing')).toBeUndefined();
    // Latency should still be recorded
    const latencies = metrics.routeLatencies.get('failing');
    expect(latencies).toHaveLength(1);
  });
});
