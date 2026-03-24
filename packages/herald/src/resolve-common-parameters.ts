import type { BaseProviderOptions } from './types.ts';

/**
 * Resolved common parameters with only the defined (non-undefined) fields present.
 * stopSequences is omitted when it is an empty array.
 */
export type ResolvedCommonParameters = {
  [K in keyof Pick<
    BaseProviderOptions,
    'maximumTokens' | 'temperature' | 'topP' | 'stopSequences'
  >]?: NonNullable<BaseProviderOptions[K]>;
};

/**
 * Extracts the common generation parameters from provider options,
 * omitting any that are undefined and filtering out empty stopSequences.
 *
 * Each provider is responsible for mapping these to its SDK-specific
 * parameter names (e.g. maximumTokens -> max_tokens for OpenAI,
 * maximumTokens -> maxOutputTokens for Gemini).
 */
export function resolveCommonParameters(
  options: Pick<BaseProviderOptions, 'maximumTokens' | 'temperature' | 'topP' | 'stopSequences'>,
): ResolvedCommonParameters {
  const result: ResolvedCommonParameters = {};

  if (options.maximumTokens !== undefined) result.maximumTokens = options.maximumTokens;
  if (options.temperature !== undefined) result.temperature = options.temperature;
  if (options.topP !== undefined) result.topP = options.topP;
  if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
    result.stopSequences = options.stopSequences;
  }

  return result;
}
