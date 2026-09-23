import type { AnthropicConversation } from './adapters/anthropic/types';
import type { GeminiConversation } from './adapters/gemini/types';
import type { OpenAIMessage } from './adapters/openai/types';
import type { ConversationEnvironment } from './environment';
import { loadConversationAdapter } from './history-providers';
import type { ConversationProvider } from './types';

export async function createConversationFromProvider<T>(
  provider: ConversationProvider,
  payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
  environment: Partial<ConversationEnvironment> | undefined,
  create: (
    history: import('./types').ConversationHistory,
    environment?: Partial<ConversationEnvironment>,
  ) => T,
): Promise<T> {
  switch (provider) {
    case 'openai': {
      if (!Array.isArray(payload)) throw new TypeError('OpenAI provider requires an array payload');
      const adapter = await loadConversationAdapter('openai');
      return create(adapter.import(payload), environment);
    }
    case 'anthropic': {
      if (!('messages' in payload))
        throw new TypeError('Anthropic provider requires a messages payload');
      const adapter = await loadConversationAdapter('anthropic');
      return create(adapter.import(payload), environment);
    }
    case 'gemini': {
      if (!('contents' in payload))
        throw new TypeError('Gemini provider requires a contents payload');
      const adapter = await loadConversationAdapter('gemini');
      return create(adapter.import(payload), environment);
    }
    default:
      throw new TypeError('Unsupported conversation provider');
  }
}
