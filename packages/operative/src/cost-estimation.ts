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
  cacheWriteCostPerMillionTokens?: number | undefined;
  /** Price for tokens served from the prompt cache. */
  cacheReadCostPerMillionTokens?: number | undefined;
  /**
   * Rates for a single request whose total input (fresh prompt plus cache reads and writes)
   * exceeds `inputTokensAbove`. Applied only to request-scoped estimates; see {@link estimateCost}.
   */
  longContext?: LongContextPricing | undefined;
}

/** A model's higher price tier for long prompts, replacing every rate above the threshold. */
export interface LongContextPricing extends Omit<ModelPricing, 'longContext'> {
  inputTokensAbove: number;
}

/**
 * Whether a usage describes one request (`'request'`, the default) or a sum over many
 * (`'aggregate'`). Long-prompt tiers are decided per request, so an aggregate is always priced at
 * the base tier: a run of many short requests must not be billed as one long one.
 */
export type CostEstimationScope = 'request' | 'aggregate';

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

/**
 * The per-component cost of every request a run has made so far, each priced on its own usage
 * (see {@link accumulateRequestCost}). Plain numbers, so a run's state can be checkpointed.
 */
export interface AccumulatedCost {
  promptCost: number;
  completionCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
}

export interface CostEstimationOptions {
  customPricing?: Record<string, ModelPricing> | undefined;
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
/** Anthropic prices cache reads on Claude Fable 5.1 and Claude Mythos 5.1 at 0.025x input. */
const ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER = 0.025;
/** Anthropic prices cache reads on Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05x input. */
const ANTHROPIC_5_5_CACHE_READ_MULTIPLIER = 0.05;
const OPENAI_CACHE_READ_MULTIPLIER = 0.5;

function anthropicCachePricing(
  promptCostPerMillionTokens: number,
  cacheReadMultiplier = ANTHROPIC_CACHE_READ_MULTIPLIER,
) {
  return {
    cacheWriteCostPerMillionTokens: promptCostPerMillionTokens * ANTHROPIC_CACHE_WRITE_MULTIPLIER,
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * cacheReadMultiplier,
  };
}

function anthropicPricing(
  promptCostPerMillionTokens: number,
  completionCostPerMillionTokens: number,
  cacheReadMultiplier?: number,
): ModelPricing {
  return {
    promptCostPerMillionTokens,
    completionCostPerMillionTokens,
    ...anthropicCachePricing(promptCostPerMillionTokens, cacheReadMultiplier),
  };
}

function openAICachePricing(promptCostPerMillionTokens: number) {
  return {
    cacheReadCostPerMillionTokens: promptCostPerMillionTokens * OPENAI_CACHE_READ_MULTIPLIER,
  };
}

export const defaultPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic current models, at the first-party list prices on Anthropic's pricing page
  // (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-13). Cache writes use the
  // 5-minute rate; consumers on the 1-hour TTL (2x input) can override via `customPricing`.
  // Claude Haiku 5.5 moves to $0.50 / $2.50 for a request over 100K input tokens (`longContext`).
  'claude-fable-5-1': anthropicPricing(10, 50, ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER),
  'claude-mythos-5-1': anthropicPricing(10, 50, ANTHROPIC_FABLE_5_1_CACHE_READ_MULTIPLIER),
  'claude-fable-5': anthropicPricing(10, 50),
  'claude-mythos-5': anthropicPricing(10, 50),
  'claude-opus-5-5': anthropicPricing(4, 20, ANTHROPIC_5_5_CACHE_READ_MULTIPLIER),
  'claude-opus-5': anthropicPricing(5, 25),
  'claude-opus-4-8': anthropicPricing(5, 25),
  'claude-opus-4-7': anthropicPricing(5, 25),
  'claude-opus-4-6': anthropicPricing(5, 25),
  'claude-opus-4-5': anthropicPricing(5, 25),
  'claude-sonnet-5-5': anthropicPricing(2, 10, ANTHROPIC_5_5_CACHE_READ_MULTIPLIER),
  'claude-sonnet-5': anthropicPricing(2, 10),
  'claude-sonnet-4-6': anthropicPricing(3, 15),
  'claude-haiku-5-5': {
    ...anthropicPricing(0.1, 0.5),
    longContext: { inputTokensAbove: 100_000, ...anthropicPricing(0.5, 2.5) },
  },
  'claude-haiku-4-5': anthropicPricing(1, 5),

  // Anthropic Claude 4 / 3.5 dated snapshots
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

/**
 * Estimate a prompt-cache hit rate from a {@link TokenUsage}.
 *
 * `cacheReadTokens / (cacheReadTokens + cacheCreationTokens + prompt)` — the
 * fraction of this request's non-completion input that was served from the
 * cache rather than written fresh or sent uncached. Returns `undefined` when
 * the usage carries no cache signal at all (`cacheReadTokens` and
 * `cacheCreationTokens` both absent), so "no data" is never confused with
 * "0% hit rate". A request that only ever writes to the cache (first turn,
 * `cacheReadTokens` absent, `cacheCreationTokens` present) correctly reports
 * `0`.
 */
export function estimateCacheHitRate(usage: TokenUsage): number | undefined {
  if (usage.cacheReadTokens === undefined && usage.cacheCreationTokens === undefined) {
    return undefined;
  }

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const denominator = cacheReadTokens + cacheCreationTokens + usage.prompt;

  return denominator === 0 ? 0 : cacheReadTokens / denominator;
}

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
  scope: CostEstimationScope = 'request',
): CostEstimate {
  const pricing = getModelPricing(model, options);
  if (!pricing) {
    throw new Error(`No pricing found for model: ${model}`);
  }

  const inputTokens =
    usage.prompt + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const rates =
    scope === 'request' && pricing.longContext && inputTokens > pricing.longContext.inputTokensAbove
      ? pricing.longContext
      : pricing;

  const promptCost = (usage.prompt / 1_000_000) * rates.promptCostPerMillionTokens;
  const completionCost = (usage.completion / 1_000_000) * rates.completionCostPerMillionTokens;
  const cacheWriteCost =
    usage.cacheCreationTokens !== undefined && rates.cacheWriteCostPerMillionTokens !== undefined
      ? (usage.cacheCreationTokens / 1_000_000) * rates.cacheWriteCostPerMillionTokens
      : 0;
  const cacheReadCost =
    usage.cacheReadTokens !== undefined && rates.cacheReadCostPerMillionTokens !== undefined
      ? (usage.cacheReadTokens / 1_000_000) * rates.cacheReadCostPerMillionTokens
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

/**
 * Price usage whose per-request breakdown is unknown — a checkpoint written before costs were
 * accumulated — at the base tier, the best estimate available for it. Returns `undefined` for
 * no usage or an unpriced model.
 */
export function seedAccumulatedCost(
  prior: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
): AccumulatedCost | undefined {
  const hasUsage =
    prior.prompt > 0 ||
    prior.completion > 0 ||
    (prior.cacheCreationTokens ?? 0) > 0 ||
    (prior.cacheReadTokens ?? 0) > 0;
  if (!hasUsage || !getModelPricing(model, options)) return undefined;
  const { promptCost, completionCost, cacheWriteCost, cacheReadCost } = estimateCost(
    prior,
    model,
    options,
    'aggregate',
  );
  return { promptCost, completionCost, cacheWriteCost, cacheReadCost };
}

/**
 * Add one request's cost to a run's {@link AccumulatedCost}. The request is priced on its own
 * usage, so a long-prompt tier applies to exactly the requests that crossed its threshold, never
 * to a sum of many short ones. Returns `current` unchanged when the model has no pricing.
 */
export function accumulateRequestCost(
  current: AccumulatedCost | undefined,
  usage: TokenUsage,
  model: string,
  options?: CostEstimationOptions,
): AccumulatedCost | undefined {
  if (!getModelPricing(model, options)) return current;
  const request = estimateCost(usage, model, options, 'request');
  return {
    promptCost: (current?.promptCost ?? 0) + request.promptCost,
    completionCost: (current?.completionCost ?? 0) + request.completionCost,
    cacheWriteCost: (current?.cacheWriteCost ?? 0) + request.cacheWriteCost,
    cacheReadCost: (current?.cacheReadCost ?? 0) + request.cacheReadCost,
  };
}
