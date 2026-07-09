/**
 * Regression tests for AB-92: every terminal `RunResult` — abort, error, and
 * a cost-budget-monitor stop — carries the accumulated `usage` and, when
 * `RunOptions.costEstimation` is supplied, a `costEstimate` computed from it.
 * `costEstimate` is never fabricated: it stays absent when `costEstimation`
 * is omitted or its model has no resolvable pricing.
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createCostBudgetMonitor } from '../src/cost-budget-monitor';
import { executeLoop } from '../src/loop';
import type { GenerateResponse } from '../src/types';

function usageResponse(content: string, usage: GenerateResponse['usage']): GenerateResponse {
  return { content, toolCalls: [], usage };
}

describe('RunResult terminal usage + costEstimate parity', () => {
  it('an errored run carries accumulated usage and a costEstimate', async () => {
    let calls = 0;
    const result = await executeLoop({
      generate: async () => {
        calls++;
        if (calls === 1) {
          return usageResponse('partial', { prompt: 100, completion: 50, total: 150 });
        }
        throw new Error('boom');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      costEstimation: { model: 'gpt-4o' },
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.usage).toEqual({ prompt: 100, completion: 50, total: 150 });
    // gpt-4o: prompt=$2.50/M, completion=$10/M
    expect(result.costEstimate).toBeDefined();
    expect(result.costEstimate!.model).toBe('gpt-4o');
    expect(result.costEstimate!.totalCost).toBeCloseTo(
      (100 / 1_000_000) * 2.5 + (50 / 1_000_000) * 10,
      10,
    );
  });

  it('an aborted run carries accumulated usage and a costEstimate', async () => {
    // The signal aborts DURING the second generate call. `runStep` checks
    // `signal.aborted` before accumulating that step's usage, so the abort
    // result carries only the first step's usage — matching the loop's real
    // short-circuit order, not a hand-picked total.
    const controller = new AbortController();
    let calls = 0;
    const result = await executeLoop({
      generate: async () => {
        calls++;
        if (calls === 1) {
          return usageResponse('partial', { prompt: 200, completion: 20, total: 220 });
        }
        controller.abort('stop now');
        return usageResponse('unreachable', { prompt: 999, completion: 999, total: 1998 });
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      costEstimation: { model: 'gpt-4o' },
    });

    expect(result.finishReason).toBe('aborted');
    expect(result.usage).toEqual({ prompt: 200, completion: 20, total: 220 });
    expect(result.costEstimate).toBeDefined();
    expect(result.costEstimate!.totalCost).toBeCloseTo(
      (200 / 1_000_000) * 2.5 + (20 / 1_000_000) * 10,
      10,
    );
  });

  it('a createCostBudgetMonitor stop still yields a terminal result with usage and costEstimate', async () => {
    const monitor = createCostBudgetMonitor({ budget: 0.001, model: 'gpt-4o' });
    let calls = 0;
    const result = await executeLoop({
      generate: async () => {
        calls++;
        return usageResponse(`step ${calls}`, { prompt: 1000, completion: 500, total: 1500 });
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: monitor.stopCondition,
      costEstimation: { model: 'gpt-4o' },
    });

    // The budget monitor's stop condition fires as an ordinary stop-condition,
    // not the `budget-exceeded` error path.
    expect(result.finishReason).toBe('stop-condition');
    expect(result.usage).toEqual({ prompt: 1000, completion: 500, total: 1500 });
    expect(result.costEstimate).toBeDefined();
    expect(result.costEstimate!.totalCost).toBeCloseTo(
      (1000 / 1_000_000) * 2.5 + (500 / 1_000_000) * 10,
      10,
    );
    expect(result.costEstimate!.totalCost).toBeGreaterThanOrEqual(monitor.currentCost);
  });

  it('leaves costEstimate absent when costEstimation is omitted, for all three exits', async () => {
    const errored = await executeLoop({
      generate: async () => {
        throw new Error('boom');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
    });
    expect(errored.costEstimate).toBeUndefined();

    const aborted = await executeLoop({
      generate: async () => usageResponse('x', { prompt: 1, completion: 1, total: 2 }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: AbortSignal.abort('stop'),
    });
    expect(aborted.costEstimate).toBeUndefined();

    const monitor = createCostBudgetMonitor({ budget: 0.001, model: 'gpt-4o' });
    const stopped = await executeLoop({
      generate: async () => usageResponse('x', { prompt: 1000, completion: 500, total: 1500 }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: monitor.stopCondition,
    });
    expect(stopped.costEstimate).toBeUndefined();
  });

  it('leaves costEstimate absent (never fabricated) when the configured model has no resolvable pricing', async () => {
    const result = await executeLoop({
      generate: async () => usageResponse('x', { prompt: 1000, completion: 500, total: 1500 }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
      costEstimation: { model: 'totally-unknown-model' },
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.usage).toEqual({ prompt: 1000, completion: 500, total: 1500 });
    expect(result.costEstimate).toBeUndefined();
  });
});
