import { describe, expect, it } from 'bun:test';

import type { GenerateContext } from '../../types.ts';
import type { ModelRoute, RoutingStrategy } from '../types.ts';
import { composeStrategies } from './compose.ts';

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

function makeRoutes(): ModelRoute[] {
  return [
    { name: 'fast', generate: async () => ({ content: '', toolCalls: [] }) },
    { name: 'smart', generate: async () => ({ content: '', toolCalls: [] }) },
    { name: 'frontier', generate: async () => ({ content: '', toolCalls: [] }) },
  ];
}

describe('composeStrategies', () => {
  it('uses the first strategy that returns a matching route', () => {
    const strategyA: RoutingStrategy = () => ({ route: 'nonexistent', reason: 'no match' });
    const strategyB: RoutingStrategy = () => ({ route: 'smart', reason: 'matched' });
    const strategyC: RoutingStrategy = () => ({ route: 'frontier', reason: 'also matched' });

    const composed = composeStrategies(strategyA, strategyB, strategyC);
    const routes = makeRoutes();
    const context = makeContext();

    const decision = composed(context, routes);
    expect(decision.route).toBe('smart');
    expect(decision.reason).toBe('matched');
  });

  it('falls back to the last strategy when earlier ones do not match routes', () => {
    const strategyA: RoutingStrategy = () => ({ route: 'nonexistent', reason: 'no match' });
    const strategyB: RoutingStrategy = () => ({ route: 'also-nonexistent', reason: 'no match' });
    const strategyC: RoutingStrategy = () => ({ route: 'frontier', reason: 'final match' });

    const composed = composeStrategies(strategyA, strategyB, strategyC);
    const routes = makeRoutes();
    const context = makeContext();

    const decision = composed(context, routes);
    expect(decision.route).toBe('frontier');
    expect(decision.reason).toBe('final match');
  });

  it('returns fallback decision when no strategy matches any route', () => {
    const strategyA: RoutingStrategy = () => ({ route: 'nonexistent-a', reason: 'miss' });
    const strategyB: RoutingStrategy = () => ({ route: 'nonexistent-b', reason: 'miss' });

    const composed = composeStrategies(strategyA, strategyB);
    const routes = makeRoutes();
    const context = makeContext();

    const decision = composed(context, routes);
    // When all miss, returns the last strategy's decision (even if unmatched)
    expect(decision.route).toBe('nonexistent-b');
  });

  it('passes context and routes to each strategy', () => {
    const calls: Array<{ step: number; routeCount: number }> = [];

    const strategy: RoutingStrategy = (context, routes) => {
      calls.push({ step: context.step, routeCount: routes.length });
      return { route: 'fast', reason: 'ok' };
    };

    const composed = composeStrategies(strategy);
    const routes = makeRoutes();
    const context = makeContext({ step: 42 });

    composed(context, routes);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.step).toBe(42);
    expect(calls[0]!.routeCount).toBe(3);
  });

  it('short-circuits on first matching strategy', () => {
    let bCalled = false;

    const strategyA: RoutingStrategy = () => ({ route: 'fast', reason: 'first' });
    const strategyB: RoutingStrategy = () => {
      bCalled = true;
      return { route: 'smart', reason: 'second' };
    };

    const composed = composeStrategies(strategyA, strategyB);
    const routes = makeRoutes();
    const context = makeContext();

    const decision = composed(context, routes);
    expect(decision.route).toBe('fast');
    expect(bCalled).toBe(false);
  });

  it('works with a single strategy', () => {
    const strategy: RoutingStrategy = () => ({ route: 'smart', reason: 'only' });

    const composed = composeStrategies(strategy);
    const routes = makeRoutes();
    const context = makeContext();

    const decision = composed(context, routes);
    expect(decision.route).toBe('smart');
    expect(decision.reason).toBe('only');
  });
});
