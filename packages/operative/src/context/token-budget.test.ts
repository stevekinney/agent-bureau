import { describe, expect, it } from 'bun:test';

import { createTokenBudget } from './token-budget';

describe('createTokenBudget', () => {
  it('tracks used and remaining correctly', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(10000);

    budget.update(3000);
    expect(budget.used).toBe(3000);
    expect(budget.remaining).toBe(7000);
  });

  it('accumulates multiple updates', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    budget.update(2000);
    budget.update(3000);
    expect(budget.used).toBe(5000);
    expect(budget.remaining).toBe(5000);
  });

  it('flips exceeds at compactionThreshold', () => {
    const budget = createTokenBudget({ maxTokens: 10000, compactionThreshold: 8000 });
    expect(budget.exceeds).toBe(false);

    budget.update(7999);
    expect(budget.exceeds).toBe(false);

    budget.update(1);
    expect(budget.exceeds).toBe(true);

    budget.update(1000);
    expect(budget.exceeds).toBe(true);
  });

  it('defaults compactionThreshold to 80% of maxTokens', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    budget.update(7999);
    expect(budget.exceeds).toBe(false);

    budget.update(1);
    expect(budget.exceeds).toBe(true);
  });

  it('flips warning at warningThreshold', () => {
    const budget = createTokenBudget({ maxTokens: 10000, warningThreshold: 2000 });
    expect(budget.warning).toBe(false);

    budget.update(7999);
    expect(budget.warning).toBe(false);

    budget.update(1);
    expect(budget.warning).toBe(true);
  });

  it('defaults warningThreshold to 20% of maxTokens remaining', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    // warning when remaining <= 2000, i.e. used >= 8000
    budget.update(7999);
    expect(budget.warning).toBe(false);

    budget.update(1);
    expect(budget.warning).toBe(true);
  });

  it('allocate returns proportional budget for named slices', () => {
    const budget = createTokenBudget({ maxTokens: 10000, minimumResponseTokens: 1500 });
    // Allocatable = 10000 - 1500 = 8500
    const allocated = budget.allocate('system');
    // Without a ratio, allocate returns the full allocatable budget
    expect(allocated).toBe(8500);
  });

  it('allocate returns proportional budget with a ratio', () => {
    const budget = createTokenBudget({ maxTokens: 10000, minimumResponseTokens: 1500 });
    // Allocatable = 10000 - 1500 = 8500
    const allocated = budget.allocate('system', 0.25);
    expect(allocated).toBe(Math.floor(8500 * 0.25));
  });

  it('never allows fewer than minimumResponseTokens remaining in allocations', () => {
    const budget = createTokenBudget({ maxTokens: 10000, minimumResponseTokens: 1500 });
    budget.update(9000);
    // Only 1000 remaining, but minimumResponseTokens is 1500
    // Allocatable = max(0, remaining - minimumResponseTokens) = max(0, 1000 - 1500) = 0
    const allocated = budget.allocate('anything');
    expect(allocated).toBe(0);
  });

  it('defaults minimumResponseTokens to 1500', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    const allocated = budget.allocate('system');
    expect(allocated).toBe(8500);
  });

  it('uses custom tokenEstimator when provided', () => {
    const tokenEstimator = (text: string) => text.length * 2;
    const budget = createTokenBudget({ maxTokens: 10000, tokenEstimator });
    expect(budget.estimate('hello')).toBe(10);
  });

  it('defaults tokenEstimator to Math.ceil(text.length / 4)', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    expect(budget.estimate('hello world!')).toBe(Math.ceil(12 / 4));
  });

  it('exposes maxTokens as readonly', () => {
    const budget = createTokenBudget({ maxTokens: 10000 });
    expect(budget.maxTokens).toBe(10000);
  });

  it('exposes minimumResponseTokens as readonly', () => {
    const budget = createTokenBudget({ maxTokens: 10000, minimumResponseTokens: 2000 });
    expect(budget.minimumResponseTokens).toBe(2000);
  });

  it('exposes warningThreshold as readonly', () => {
    const budget = createTokenBudget({ maxTokens: 10000, warningThreshold: 3000 });
    expect(budget.warningThreshold).toBe(3000);
  });

  it('exposes compactionThreshold as readonly', () => {
    const budget = createTokenBudget({ maxTokens: 10000, compactionThreshold: 7000 });
    expect(budget.compactionThreshold).toBe(7000);
  });
});
