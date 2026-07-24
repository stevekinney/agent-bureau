import type { GenerateFunction } from '@lostgradient/operative';
import { createAnthropicProvider } from '@lostgradient/operative/anthropic';
import { createGeminiProvider } from '@lostgradient/operative/gemini';
import { createOpenAIProvider } from '@lostgradient/operative/openai';

import type { ProviderConfiguration } from './types';

/**
 * Resolves a ProviderConfiguration into a GenerateFunction using the
 * operative provider subpaths (folded from herald in Phase C).
 */
export function resolveGenerate(provider: ProviderConfiguration): GenerateFunction {
  switch (provider.provider) {
    case 'anthropic':
      return createAnthropicProvider({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    case 'openai':
      return createOpenAIProvider({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    case 'gemini':
      return createGeminiProvider({
        model: provider.model,
        maximumTokens: provider.maximumTokens,
        temperature: provider.temperature,
        apiKey: provider.apiKey,
      });
    default:
      throw new Error(`Unknown provider: ${String(provider.provider)}`);
  }
}
