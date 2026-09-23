import type { AnthropicConversation } from './adapters/anthropic/types';
import type { GeminiConversation } from './adapters/gemini/types';
import type { OpenAIMessage } from './adapters/openai/types';
import type { ConversationEnvironment } from './environment';
import { collectToolCallIds, diffConversationMessages } from './history-messages';
import { getOpenAIExportOptions, loadConversationAdapter } from './history-providers';
import type { ConversationHistory, ConversationProvider } from './types';

type ProviderHooks = {
  readonly current: () => ConversationHistory;
  readonly environment: ConversationEnvironment;
  readonly runOwned: <T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly commit: (
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
    context: { messageIds?: string[]; toolCallIds?: string[] },
  ) => void;
};

export type ProviderActions = {
  readonly toProvider: {
    (provider: 'openai', options?: unknown): Promise<OpenAIMessage[]>;
    (provider: 'anthropic', options?: unknown): Promise<AnthropicConversation>;
    (provider: 'gemini', options?: unknown): Promise<GeminiConversation>;
    (
      provider: ConversationProvider,
      options?: unknown,
    ): Promise<OpenAIMessage[] | AnthropicConversation | GeminiConversation>;
  };
  readonly appendProvider: (
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
  ) => Promise<void>;
  readonly toOpenAIMessages: () => Promise<OpenAIMessage[]>;
  readonly toOpenAIMessagesGrouped: () => Promise<OpenAIMessage[]>;
  readonly toAnthropicMessages: () => Promise<AnthropicConversation>;
  readonly toGeminiMessages: () => Promise<GeminiConversation>;
};

function finishAppend(hooks: ProviderHooks, next: ConversationHistory): void {
  if (next === hooks.current()) return;
  const diff = diffConversationMessages(hooks.current(), next);
  const action =
    diff.removed.length > 0
      ? 'messages.removed'
      : diff.updated.length > 0
        ? 'messages.updated'
        : 'messages.appended';
  const messageIds =
    action === 'messages.removed'
      ? diff.removed
      : action === 'messages.updated'
        ? diff.updated
        : diff.appended;
  const toolCallIds = collectToolCallIds(next, messageIds);
  hooks.commit(next, action, {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    ...(toolCallIds ? { toolCallIds } : {}),
  });
}

async function appendOpenAI(hooks: ProviderHooks, payload: OpenAIMessage[]): Promise<void> {
  const adapter = await hooks.runOwned('appendProvider', () => loadConversationAdapter('openai'));
  finishAppend(hooks, adapter.append(hooks.current(), payload));
}

async function appendAnthropic(
  hooks: ProviderHooks,
  payload: AnthropicConversation,
): Promise<void> {
  const adapter = await hooks.runOwned('appendProvider', () =>
    loadConversationAdapter('anthropic'),
  );
  finishAppend(hooks, adapter.append(hooks.current(), payload));
}

async function appendGemini(hooks: ProviderHooks, payload: GeminiConversation): Promise<void> {
  const adapter = await hooks.runOwned('appendProvider', () => loadConversationAdapter('gemini'));
  finishAppend(hooks, adapter.append(hooks.current(), payload));
}

export function createProviderActions(hooks: ProviderHooks): ProviderActions {
  async function toProvider(provider: 'openai', options?: unknown): Promise<OpenAIMessage[]>;
  async function toProvider(
    provider: 'anthropic',
    options?: unknown,
  ): Promise<AnthropicConversation>;
  async function toProvider(provider: 'gemini', options?: unknown): Promise<GeminiConversation>;
  async function toProvider(
    provider: ConversationProvider,
    options?: unknown,
  ): Promise<OpenAIMessage[] | AnthropicConversation | GeminiConversation>;
  async function toProvider(
    provider: ConversationProvider,
    options?: unknown,
  ): Promise<OpenAIMessage[] | AnthropicConversation | GeminiConversation> {
    const adapter = await loadConversationAdapter(provider);
    return provider === 'openai'
      ? adapter.export(hooks.current(), getOpenAIExportOptions(options))
      : adapter.export(hooks.current());
  }

  const appendProvider = async (
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
  ): Promise<void> => {
    if (provider === 'openai') {
      if (!Array.isArray(payload)) throw new TypeError('OpenAI provider requires an array payload');
      await appendOpenAI(hooks, payload);
      return;
    }
    if (provider === 'anthropic') {
      if (!('messages' in payload))
        throw new TypeError('Anthropic provider requires a messages payload');
      await appendAnthropic(hooks, payload);
      return;
    }
    if (!('contents' in payload))
      throw new TypeError('Gemini provider requires a contents payload');
    await appendGemini(hooks, payload);
  };
  return {
    toProvider,
    appendProvider,
    toOpenAIMessages: () => toProvider('openai', { groupToolCalls: false }),
    toOpenAIMessagesGrouped: () => toProvider('openai', { groupToolCalls: true }),
    toAnthropicMessages: () => toProvider('anthropic'),
    toGeminiMessages: () => toProvider('gemini'),
  };
}
