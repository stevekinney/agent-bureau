import { createAnthropicGenerate, createGeminiGenerate, createOpenAIGenerate } from 'herald';
import type { GenerateFunction } from 'operative';

import type { ProviderConfiguration } from './types';

/**
 * Resolves a ProviderConfiguration into a GenerateFunction using herald's
 * factory functions.
 */
export function resolveGenerate(provider: ProviderConfiguration): GenerateFunction {
  switch (provider.provider) {
    case 'anthropic':
      return createAnthropicGenerate({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    case 'openai':
      return createOpenAIGenerate({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    case 'gemini':
      return createGeminiGenerate({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    default:
      throw new Error(`Unknown provider: ${String(provider.provider)}`);
  }
}
