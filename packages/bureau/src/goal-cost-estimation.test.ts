import { describe, expect, it } from 'bun:test';

import { isGoalAttemptCostEstimation } from './goal-cost-estimation';

describe('isGoalAttemptCostEstimation', () => {
  it.each([
    null,
    { model: 'gpt-4o' },
    { model: 'x', pricing: {} },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: {
            promptCostPerMillionTokens: 1,
            completionCostPerMillionTokens: 2,
            cacheReadCostPerMillionTokens: 0.1,
          },
        },
      },
    },
  ])('accepts a plain-JSON selection: %j', (value) => {
    expect(isGoalAttemptCostEstimation(value)).toBe(true);
    expect(isGoalAttemptCostEstimation(JSON.parse(JSON.stringify(value)))).toBe(true);
  });

  it.each([
    'gpt-4o',
    ['model'],
    {},
    { model: '' },
    { model: 7 },
    { model: 'x', extra: true },
    { model: 'x', pricing: 'cheap' },
    { model: 'x', pricing: { other: {} } },
    { model: 'x', pricing: { customPricing: { x: { promptCostPerMillionTokens: 1 } } } },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: { promptCostPerMillionTokens: Number.NaN, completionCostPerMillionTokens: 1 },
        },
      },
    },
    {
      model: 'x',
      pricing: {
        customPricing: {
          x: { promptCostPerMillionTokens: -1, completionCostPerMillionTokens: 1 },
        },
      },
    },
  ])('refuses what the decoder and the write must not carry: %j', (value) => {
    expect(isGoalAttemptCostEstimation(value)).toBe(false);
  });
});

describe('isGoalAttemptCostEstimation absence', () => {
  it('is not a selection: an attempt with nothing persisted is not the same as one persisted as none', () => {
    expect(isGoalAttemptCostEstimation(undefined)).toBe(false);
  });
});
