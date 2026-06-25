import { describe, expect, it } from 'bun:test';

import { createCostAwareStrategy } from './cost-aware.ts';
import { makeContext, makeRoutes } from './test-helpers.ts';

describe('createCostAwareStrategy', () => {
  it('routes to expensive model when under budget threshold', () => {
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.8,
      getBudgetState: () => ({ spent: 10, budget: 100 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    const decision = strategy(context, routes);
    expect(decision.route).toBe('expensive');
    expect(decision.reason).toContain('under budget');
  });

  it('routes to cheap model when at budget threshold', () => {
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.8,
      getBudgetState: () => ({ spent: 80, budget: 100 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    const decision = strategy(context, routes);
    expect(decision.route).toBe('cheap');
    expect(decision.reason).toContain('budget');
  });

  it('routes to cheap model when over budget threshold', () => {
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.8,
      getBudgetState: () => ({ spent: 90, budget: 100 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    const decision = strategy(context, routes);
    expect(decision.route).toBe('cheap');
  });

  it('queries budget state fresh each call', () => {
    let spent = 0;
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.5,
      getBudgetState: () => ({ spent, budget: 100 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    // Under threshold
    expect(strategy(context, routes).route).toBe('expensive');

    // Increment spending to cross threshold
    spent = 50;
    expect(strategy(context, routes).route).toBe('cheap');

    // Further over threshold
    spent = 90;
    expect(strategy(context, routes).route).toBe('cheap');
  });

  it('handles zero budget without division error', () => {
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.8,
      getBudgetState: () => ({ spent: 0, budget: 0 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    // 0/0 is NaN, which should be treated as over budget (safe default)
    const decision = strategy(context, routes);
    expect(decision.route).toBe('cheap');
  });

  it('uses exact threshold ratio comparison', () => {
    const strategy = createCostAwareStrategy({
      thresholdRatio: 0.5,
      getBudgetState: () => ({ spent: 49.9, budget: 100 }),
      cheap: 'cheap',
      expensive: 'expensive',
    });
    const routes = makeRoutes(['cheap', 'expensive']);
    const context = makeContext();

    // 49.9 / 100 = 0.499 < 0.5 — should be expensive
    expect(strategy(context, routes).route).toBe('expensive');
  });
});
