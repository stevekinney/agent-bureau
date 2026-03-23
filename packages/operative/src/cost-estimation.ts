import type { TokenUsage } from './types';

export interface ModelPricing {
  promptCostPerMillionTokens: number;
  completionCostPerMillionTokens: number;
}

export interface CostEstimate {
  promptCost: number;
  completionCost: number;
  totalCost: number;
  model: string;
  usage: TokenUsage;
}

export interface CostEstimationOptions {
  customPricing?: Record<string, ModelPricing>;
}

export const defaultPricingTable: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic Claude 4 / 3.5
  'claude-opus-4-20250514': { promptCostPerMillionTokens: 15, completionCostPerMillionTokens: 75 },
  'claude-sonnet-4-20250514': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
  },
  'claude-haiku-4-20250506': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
  },
  'claude-3-5-sonnet-20241022': {
    promptCostPerMillionTokens: 3,
    completionCostPerMillionTokens: 15,
  },
  'claude-3-5-haiku-20241022': {
    promptCostPerMillionTokens: 0.8,
    completionCostPerMillionTokens: 4,
  },

  // OpenAI GPT-4o / 4.1 / o3 / o4-mini
  'gpt-4o': { promptCostPerMillionTokens: 2.5, completionCostPerMillionTokens: 10 },
  'gpt-4o-mini': { promptCostPerMillionTokens: 0.15, completionCostPerMillionTokens: 0.6 },
  'gpt-4.1': { promptCostPerMillionTokens: 2, completionCostPerMillionTokens: 8 },
  'gpt-4.1-mini': { promptCostPerMillionTokens: 0.4, completionCostPerMillionTokens: 1.6 },
  'gpt-4.1-nano': { promptCostPerMillionTokens: 0.1, completionCostPerMillionTokens: 0.4 },
  o3: { promptCostPerMillionTokens: 10, completionCostPerMillionTokens: 40 },
  'o3-mini': { promptCostPerMillionTokens: 1.1, completionCostPerMillionTokens: 4.4 },
  'o4-mini': { promptCostPerMillionTokens: 1.1, completionCostPerMillionTokens: 4.4 },

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

  return {
    promptCost,
    completionCost,
    totalCost: promptCost + completionCost,
    model,
    usage,
  };
}
