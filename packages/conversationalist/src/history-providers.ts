import type { AnthropicConversation } from './adapters/anthropic/types';
import type { GeminiConversation } from './adapters/gemini/types';
import type { OpenAIConversationExportOptions, OpenAIMessage } from './adapters/openai/types';
import type { ConversationProvider } from './types';

export type ProviderPayload = OpenAIMessage[] | AnthropicConversation | GeminiConversation;

type OpenAIAdapter = typeof import('./adapters/openai').openAIConversationAdapter;
type AnthropicAdapter = typeof import('./adapters/anthropic').anthropicConversationAdapter;
type GeminiAdapter = typeof import('./adapters/gemini').geminiConversationAdapter;

export type ConversationAdapter = OpenAIAdapter | AnthropicAdapter | GeminiAdapter;

/** Returns the documented OpenAI export option when one was supplied. */
export function getOpenAIExportOptions(options: unknown): OpenAIConversationExportOptions {
  if (typeof options !== 'object' || options === null || !('groupToolCalls' in options)) {
    return {};
  }
  const groupToolCalls = options.groupToolCalls;
  return typeof groupToolCalls === 'boolean' ? { groupToolCalls } : {};
}

export function loadConversationAdapter(provider: 'openai'): Promise<OpenAIAdapter>;
export function loadConversationAdapter(provider: 'anthropic'): Promise<AnthropicAdapter>;
export function loadConversationAdapter(provider: 'gemini'): Promise<GeminiAdapter>;
export function loadConversationAdapter(
  provider: ConversationProvider,
): Promise<ConversationAdapter>;
/** Loads the existing provider adapter lazily and preserves its native type. */
export function loadConversationAdapter(
  provider: ConversationProvider,
): Promise<ConversationAdapter> {
  switch (provider) {
    case 'openai':
      return import('./adapters/openai').then((module) => module.openAIConversationAdapter);
    case 'anthropic':
      return import('./adapters/anthropic').then((module) => module.anthropicConversationAdapter);
    case 'gemini':
      return import('./adapters/gemini').then((module) => module.geminiConversationAdapter);
    default:
      return Promise.reject(
        new TypeError(`Unsupported conversation provider: ${String(provider)}`),
      );
  }
}
