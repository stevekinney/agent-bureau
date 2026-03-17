import type { Content } from '@google/generative-ai';
import { describe, expectTypeOf, it } from 'bun:test';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { toAnthropicMessages } from '../src/adapters/anthropic';
import { toGeminiMessages } from '../src/adapters/gemini';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai';
import type { Conversation } from '../src/types';

describe('Adapter Type Compatibility', () => {
  const conv: Conversation = {
    schemaVersion: 1,
    id: 'test',
    status: 'active',
    metadata: {},
    ids: [],
    messages: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  describe('OpenAI Adapter', () => {
    it('should be compatible with OpenAI SDK types', () => {
      const messages = toOpenAIMessages(conv);
      const groupedMessages = toOpenAIMessagesGrouped(conv);

      expectTypeOf(messages).toExtend<ChatCompletionMessageParam[]>();
      expectTypeOf(groupedMessages).toExtend<ChatCompletionMessageParam[]>();
    });
  });

  describe('Anthropic Adapter', () => {
    it('should be compatible with Anthropic SDK types', () => {
      const { messages, system } = toAnthropicMessages(conv);

      type AnthropicMessageParamLike = {
        role: 'user' | 'assistant';
        content: string | Array<{ type: string }>;
      };

      expectTypeOf(messages).toMatchTypeOf<AnthropicMessageParamLike[]>();
      expectTypeOf(system).toEqualTypeOf<string | undefined>();
    });
  });

  describe('Gemini Adapter', () => {
    it('should be compatible with Gemini SDK types', () => {
      const { contents, systemInstruction } = toGeminiMessages(conv);

      expectTypeOf(contents).toExtend<Content[]>();
      expectTypeOf(systemInstruction).toExtend<Content | undefined>();
    });
  });
});
