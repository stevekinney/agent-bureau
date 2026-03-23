import { describe, expect, it } from 'bun:test';

import {
  type CostEstimate,
  defaultPricingTable,
  estimateCost,
  getModelPricing,
  type ModelPricing,
} from '../src/cost-estimation.ts';

describe('estimateCost', () => {
  it('computes correct cost for a known Anthropic model', () => {
    // claude-sonnet-4-20250514: prompt=$3/M, completion=$15/M
    const result: CostEstimate = estimateCost(
      { prompt: 1000, completion: 500, total: 1500 },
      'claude-sonnet-4-20250514',
    );

    expect(result.promptCost).toBe((1000 / 1_000_000) * 3);
    expect(result.completionCost).toBe((500 / 1_000_000) * 15);
    expect(result.totalCost).toBe(0.003 + 0.0075);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage).toEqual({ prompt: 1000, completion: 500, total: 1500 });
  });

  it('computes correct cost for a known OpenAI model', () => {
    // gpt-4o: prompt=$2.50/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 2000, completion: 1000, total: 3000 },
      'gpt-4o',
    );

    expect(result.promptCost).toBe((2000 / 1_000_000) * 2.5);
    expect(result.completionCost).toBe((1000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.01);
    expect(result.model).toBe('gpt-4o');
  });

  it('computes correct cost for a known Gemini model', () => {
    // gemini-2.5-pro: prompt=$1.25/M, completion=$10/M
    const result: CostEstimate = estimateCost(
      { prompt: 4000, completion: 2000, total: 6000 },
      'gemini-2.5-pro',
    );

    expect(result.promptCost).toBe((4000 / 1_000_000) * 1.25);
    expect(result.completionCost).toBe((2000 / 1_000_000) * 10);
    expect(result.totalCost).toBe(0.005 + 0.02);
    expect(result.model).toBe('gemini-2.5-pro');
  });

  it('throws for an unknown model', () => {
    expect(() =>
      estimateCost({ prompt: 100, completion: 50, total: 150 }, 'unknown-model'),
    ).toThrow('No pricing found for model: unknown-model');
  });

  it('uses custom pricing to override defaults for a known model', () => {
    const customPricing: Record<string, ModelPricing> = {
      'claude-sonnet-4-20250514': {
        promptCostPerMillionTokens: 5,
        completionCostPerMillionTokens: 20,
      },
    };

    const result = estimateCost(
      { prompt: 1000, completion: 500, total: 1500 },
      'claude-sonnet-4-20250514',
      { customPricing },
    );

    expect(result.promptCost).toBe((1000 / 1_000_000) * 5);
    expect(result.completionCost).toBe((500 / 1_000_000) * 20);
    expect(result.totalCost).toBe(0.005 + 0.01);
  });

  it('uses custom pricing for an entirely new model', () => {
    const customPricing: Record<string, ModelPricing> = {
      'my-custom-model': {
        promptCostPerMillionTokens: 1,
        completionCostPerMillionTokens: 2,
      },
    };

    const result = estimateCost(
      { prompt: 1_000_000, completion: 500_000, total: 1_500_000 },
      'my-custom-model',
      { customPricing },
    );

    expect(result.promptCost).toBe(1);
    expect(result.completionCost).toBe(1);
    expect(result.totalCost).toBe(2);
    expect(result.model).toBe('my-custom-model');
  });

  it('returns zero cost for zero usage', () => {
    const result = estimateCost({ prompt: 0, completion: 0, total: 0 }, 'claude-sonnet-4-20250514');

    expect(result.promptCost).toBe(0);
    expect(result.completionCost).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe('getModelPricing', () => {
  it('returns pricing for a known model', () => {
    const pricing = getModelPricing('gpt-4o');

    expect(pricing).toBeDefined();
    expect(pricing!.promptCostPerMillionTokens).toBe(2.5);
    expect(pricing!.completionCostPerMillionTokens).toBe(10);
  });

  it('returns undefined for an unknown model', () => {
    const pricing = getModelPricing('nonexistent-model');

    expect(pricing).toBeUndefined();
  });

  it('respects custom pricing over defaults', () => {
    const customPricing: Record<string, ModelPricing> = {
      'gpt-4o': {
        promptCostPerMillionTokens: 99,
        completionCostPerMillionTokens: 199,
      },
    };

    const pricing = getModelPricing('gpt-4o', { customPricing });

    expect(pricing).toBeDefined();
    expect(pricing!.promptCostPerMillionTokens).toBe(99);
    expect(pricing!.completionCostPerMillionTokens).toBe(199);
  });
});

describe('defaultPricingTable', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(defaultPricingTable)).toBe(true);
  });
});
