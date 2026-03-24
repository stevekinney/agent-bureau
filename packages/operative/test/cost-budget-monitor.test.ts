import { describe, expect, it } from 'bun:test';

import { stopWhen } from '../src/conditions/index';
import {
  type CostBudgetExceededEvent,
  type CostBudgetThresholdEvent,
  createCostBudgetMonitor,
} from '../src/cost-budget-monitor';
import type { StepResult } from '../src/types';

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

describe('createCostBudgetMonitor', () => {
  // gpt-4o: prompt=$2.50/M, completion=$10/M
  const model = 'gpt-4o';

  it('returns false when budget is not exceeded', () => {
    const monitor = createCostBudgetMonitor({ budget: 1.0, model });
    // 1000 prompt tokens + 500 completion tokens at gpt-4o pricing
    // cost = (1000/1M)*2.5 + (500/1M)*10 = 0.0025 + 0.005 = 0.0075
    const result = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(false);
  });

  it('returns true when budget is exceeded', () => {
    // Set a tiny budget of $0.001
    const monitor = createCostBudgetMonitor({ budget: 0.001, model });
    // cost = (1000/1M)*2.5 + (500/1M)*10 = 0.0025 + 0.005 = 0.0075
    const result = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(true);
  });

  it('fires threshold callbacks in order', () => {
    const fired: number[] = [];
    const monitor = createCostBudgetMonitor({
      budget: 0.01,
      model,
      thresholds: [0.9, 0.5, 0.75],
      onThreshold: (event) => fired.push(event.threshold),
    });

    // cost per step = (1000/1M)*2.5 + (500/1M)*10 = 0.0075
    // 0.0075 / 0.01 = 75% of budget — crosses 0.5 and 0.75
    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );

    expect(fired).toEqual([0.5, 0.75]);
  });

  it('fires each threshold only once', () => {
    const fired: number[] = [];
    const monitor = createCostBudgetMonitor({
      budget: 0.02,
      model,
      thresholds: [0.25],
      onThreshold: (event) => fired.push(event.threshold),
    });

    // First step: cost = 0.0075, 0.0075/0.02 = 37.5% — crosses 0.25
    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(fired).toEqual([0.25]);

    // Second step: cost = 0.015, still above 0.25 but should not fire again
    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(fired).toEqual([0.25]);
  });

  it('fires the onExceeded callback', () => {
    let exceededEvent: CostBudgetExceededEvent | undefined;
    const monitor = createCostBudgetMonitor({
      budget: 0.001,
      model,
      onExceeded: (event) => {
        exceededEvent = event;
      },
    });

    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );

    expect(exceededEvent).toBeDefined();
    expect(exceededEvent!.budget).toBe(0.001);
    expect(exceededEvent!.model).toBe('gpt-4o');
    expect(exceededEvent!.currentCost).toBeGreaterThan(0.001);
  });

  it('handles undefined usage gracefully', () => {
    const monitor = createCostBudgetMonitor({ budget: 1.0, model });
    const result = monitor.stopCondition(makeStepResult({ usage: undefined }));
    expect(result).toBe(false);
    expect(monitor.currentCost).toBe(0);
  });

  it('uses custom pricing', () => {
    const monitor = createCostBudgetMonitor({
      budget: 0.01,
      model: 'custom-model',
      pricing: {
        customPricing: {
          'custom-model': {
            promptCostPerMillionTokens: 100,
            completionCostPerMillionTokens: 200,
          },
        },
      },
    });

    // cost = (1000/1M)*100 + (500/1M)*200 = 0.1 + 0.1 = 0.2
    const result = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(true);
    expect(monitor.currentCost).toBe(0.2);
  });

  it('reports accurate currentCost', () => {
    const monitor = createCostBudgetMonitor({ budget: 1.0, model });

    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    // cost = (1000/1M)*2.5 + (500/1M)*10 = 0.0025 + 0.005 = 0.0075
    expect(monitor.currentCost).toBeCloseTo(0.0075, 10);
  });

  it('reports accurate firedThresholds', () => {
    const monitor = createCostBudgetMonitor({
      budget: 0.01,
      model,
      thresholds: [0.5, 0.75, 0.9],
    });

    // cost = 0.0075 => 75% of 0.01 — crosses 0.5 and 0.75
    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );

    expect(monitor.firedThresholds).toEqual([0.5, 0.75]);
  });

  it('accumulates cost across multiple invocations', () => {
    const monitor = createCostBudgetMonitor({ budget: 0.02, model });

    // Step 1: cost = 0.0075
    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(monitor.currentCost).toBeCloseTo(0.0075, 10);
    expect(monitor.stopCondition.length).toBe(1); // sanity: it's a function

    // Step 2: cost += 0.0075 = 0.015
    const result2 = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(monitor.currentCost).toBeCloseTo(0.015, 10);
    expect(result2).toBe(false);

    // Step 3: cost += 0.0075 = 0.0225 — exceeds budget of 0.02
    const result3 = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(monitor.currentCost).toBeCloseTo(0.0225, 10);
    expect(result3).toBe(true);
  });

  it('works with the stopWhen.costBudget convenience wrapper', () => {
    const condition = stopWhen.costBudget({ budget: 0.001, model });
    // cost = 0.0075 — exceeds 0.001
    const result = condition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(true);
  });

  it('stopWhen.costBudget returns false when under budget', () => {
    const condition = stopWhen.costBudget({ budget: 1.0, model });
    const result = condition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(false);
  });

  it('provides threshold event with correct fields', () => {
    let capturedEvent: CostBudgetThresholdEvent | undefined;
    const monitor = createCostBudgetMonitor({
      budget: 0.01,
      model,
      thresholds: [0.5],
      onThreshold: (event) => {
        capturedEvent = event;
      },
    });

    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.threshold).toBe(0.5);
    expect(capturedEvent!.budget).toBe(0.01);
    expect(capturedEvent!.model).toBe('gpt-4o');
    expect(capturedEvent!.currentCost).toBeCloseTo(0.0075, 10);
  });

  it('does not fire onExceeded when under budget', () => {
    let called = false;
    const monitor = createCostBudgetMonitor({
      budget: 1.0,
      model,
      onExceeded: () => {
        called = true;
      },
    });

    monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(called).toBe(false);
  });

  it('works with no thresholds configured', () => {
    const monitor = createCostBudgetMonitor({ budget: 0.001, model });
    const result = monitor.stopCondition(
      makeStepResult({ usage: { prompt: 1000, completion: 500, total: 1500 } }),
    );
    expect(result).toBe(true);
    expect(monitor.firedThresholds).toEqual([]);
  });
});
