import type { TokenUsage } from './types';

/**
 * Per-model pricing used by {@link estimateCost}.
 *
 * `cacheWriteCostPerMillionTokens` and `cacheReadCostPerMillionTokens` price
 * `TokenUsage.cacheCreationTokens`/`cacheReadTokens` at their own rates —
 * omitted for models/providers with no native cache pricing, in which case
 * any cache token counts on the usage are priced at `0` (see {@link estimateCost}).
 */
export interface ModelPricing {
  promptCostPerMillionTokens: number;
  completionCostPerMillionTokens: number;
  /** Price for tokens written to the prompt cache. Anthropic only. */
  cacheWriteCostPerMillionTokens?: number;
  /** Price for tokens served from the prompt cache. */
  cacheReadCostPerMillionTokens?: number;
}

export interface CostEstimate {
  promptCost: number;
  completionCost: number;
  /** Cost attributed to `usage.cacheCreationTokens`. `0` when absent or unpriced. */
  cacheWriteCost: number;
  /** Cost attributed to `usage.cacheReadTokens`. `0` when absent or unpriced. */
  cacheReadCost: number;
  totalCost: number;
  model: string;
  usage: TokenUsage;
}

export interface CostEstimationOptions {
  customPricing?: Record<string, ModelPricing>;
}

/**
 * Cache pricing multipliers, applied to a model's `promptCostPerMillionTokens`
 * below. Anthropic prices a 5-minute prompt-cache write at 1.25x the base
 * input rate and a cache read at 0.1x; OpenAI prices a cached-input hit at
 * 0.5x with no separate write charge. Source: Anthropic's and OpenAI's
 * published pricing pages (prompt caching / cached input sections).
 */
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const OPENAI_CACHE_READ_MULTIPLIER = 0.5;

function anthropicCachePricing(promptCostPerMillionTokens: number) {
  return {
    cacheWriteCostPerMillionTokens: promptCostPerMillionTokens * ANTHROPIC_CACHE_WRITE_MULTIPLIER,
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * ANTHROPIC_CACHE_READ_MULTIPLIER,
  };
}

function openAICachePricing(promptCostPerMillionTokens: number) {
  return {
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * OPENAI_CACHE_READ_MULTIPLIER,
  };
}

export const defaultPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic Claude 4 / 3.5
  'claude-opus-4-20250514': {
    promptCostPerMillionTokens: 15,
    completionCostPerMillionTokens: 75,
    ...anthropicCachePricing(15),
  },
  'claude-sonnet-4-20250514': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
    ...anthropicCachePricing(3),
  },
  'claude-haiku-4-20250506': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
    ...anthropicCachePricing(0.8),
  },
  'claude-3-5-sonnet-20241022': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
    ...anthropicCachePricing(3),
  },
  'claude-3-5-haiku-20241022': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
    ...anthropicCachePricing(0.8),
  },

  // OpenAI GPT-4o / 4.1 / o3 / o4-mini
  'gpt-4o': {
    promptCostPerMillionTokens: 2.5,
    completionCostPerMillionTokens: 10,
    ...openAICachePricing(2.5),
  },
  'gpt-4o-mini': {
    promptCostPerMillionTokens: 0.15,
    completionCostPerMillionTokens: 0.6,
    ...openAICachePricing(0.15),
  },
  'gpt-4.1': {
    promptCostPerMillionTokens: 2,
    completionCostPerMillionTokens: 8,
    ...openAICachePricing(2),
  },
  'gpt-4.1-mini': {
    promptCostPerMillionTokens: 0.4,
    completionCostPerMillionTokens: 1.6,
    ...openAICachePricing(0.4),
  },
  'gpt-4.1-nano': {
    promptCostPerMillionTokens: 0.1,
    completionCostPerMillionTokens: 0.4,
    ...openAICachePricing(0.1),
  },
  o3: {
    promptCostPerMillionTokens: 10,
    completionCostPerMillionTokens: 40,
    ...openAICachePricing(10),
  },
  'o3-mini': {
    promptCostPerMillionTokens: 1.1,
    completionCostPerMillionTokens: 4.4,
    ...openAICachePricing(1.1),
  },
  'o4-mini': {
    promptCostPerMillionTokens: 1.1,
    completionCostPerMillionTokens: 4.4,
    ...openAICachePricing(1.1),
  },

  // Google Gemini 2.5 / 2.0
  'gemini-2.5-pro': { promptCostPerMillionTokens: 1.25, completionCostPerMillionTokens: 10 },
  'gemini-2.5-flash': { promptCostPerMillionTokens: 0.15, completionCostPerMillionTokens: 0.6 },
  'gemini-2.0-flash': { promptCostPerMillionTokens: 0.1, completionCostPerMillionTokens: 0.4 },
});

export function getModelPricing(
  model: string,
  options?: CostEstimationOptions,
): ModelPricing | undefined {
  return options?.customPricing?.[model] ?? defaultPricingTable[model];
}

/**
 * Estimate the cost of a {@link TokenUsage} at a model's {@link ModelPricing}.
 *
 * **This estimate is for in-loop budgeting only — never for billing.** It is
 * computed from a static, hand-maintained pricing table that can drift from a
 * provider's actual invoiced rates (promotional pricing, volume discounts,
 * batch-API pricing, mid-cycle price changes). Use it to drive
 * {@link createCostBudgetMonitor} and similar in-loop stop conditions, never
 * as a source of truth for what a run actually cost.
 *
 * Cache tokens are priced at their own rate when the model's pricing defines
 * one; when `usage.cacheCreationTokens`/`cacheReadTokens` are present but the
 * model has no cache pricing, those tokens cost `0` (they're not silently
 * folded into the prompt rate).
 */
export function estimateCost(
  usage: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
): CostEstimate {
  const pricing = getModelPricing(model, options);
  if (!pricing) {
    throw new Error(`No pricing found for model: ${model}`);
  }

  const promptCost = (usage.prompt / 1_000_000) * pricing.promptCostPerMillionTokens;
  const completionCost = (usage.completion / 1_000_000) * pricing.completionCostPerMillionTokens;
  const cacheWriteCost =
    usage.cacheCreationTokens !== undefined && pricing.cacheWriteCostPerMillionTokens !== undefined
      ? (usage.cacheCreationTokens / 1_000_000) * pricing.cacheWriteCostPerMillionTokens
      : 0;
  const cacheReadCost =
    usage.cacheReadTokens !== undefined && pricing.cacheReadCostPerMillionTokens !== undefined
      ? (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadCostPerMillionTokens
      : 0;

  return {
    promptCost,
    completionCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: promptCost + completionCost + cacheWriteCost + cacheReadCost,
    model,
    usage,
  };
}
