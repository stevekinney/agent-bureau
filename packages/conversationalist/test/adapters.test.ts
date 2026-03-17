import { describe, expect, it } from 'bun:test';

import { toAnthropicMessages } from '../src/adapters/anthropic';
import { toGeminiMessages } from '../src/adapters/gemini';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai';
import { simpleTokenEstimator, truncateToTokenLimit } from '../src/context';
import {
  appendMessages,
  appendUnsafeMessage,
  createConversation,
  createConversationUnsafe,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import type { Conversation } from '../src/types';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

function createBasicConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there! How can I help you?' },
    testEnvironment,
  );
  return conv;
}

function createToolCallConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'user', content: 'What is the weather?' },
    {
      role: 'tool-use',
      content: '',
      toolCall: {
        id: 'call-123',
        name: 'get_weather',
        arguments: JSON.stringify({ location: 'NYC' }),
      },
    },
    {
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'call-123',
        outcome: 'success',
        content: { temperature: 72, conditions: 'sunny' },
      },
    },
    { role: 'assistant', content: 'The weather in NYC is 72°F and sunny.' },
    testEnvironment,
  );
  return conv;
}

function createMultiModalConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', url: 'https://example.com/image.jpg' },
      ],
    },
    { role: 'assistant', content: 'I see a cat.' },
    testEnvironment,
  );
  return conv;
}

function createBrokenToolConversation(): Conversation {
  let conv = createConversationUnsafe({ id: 'broken' }, testEnvironment);
  conv = appendUnsafeMessage(
    conv,
    {
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'missing',
        outcome: 'success',
        content: { ok: true },
      },
    },
    testEnvironment,
  );
  return conv;
}

describe('OpenAI Adapter', () => {
  describe('toOpenAIMessages', () => {
    it('converts basic conversation', () => {
      const conv = createBasicConversation();
      const messages = toOpenAIMessages(conv);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[2]).toEqual({
        role: 'assistant',
        content: 'Hi there! How can I help you?',
      });
    });

    it('converts tool calls to OpenAI format', () => {
      const conv = createToolCallConversation();
      const messages = toOpenAIMessages(conv);

      // Should have: user, assistant (with tool_calls), tool, assistant
      expect(messages).toHaveLength(4);

      // Tool call message
      const toolCallMsg = messages[1];
      expect(toolCallMsg?.role).toBe('assistant');
      if (
        !toolCallMsg ||
        toolCallMsg.role !== 'assistant' ||
        !('tool_calls' in toolCallMsg)
      ) {
        throw new Error('Expected tool call message with tool_calls');
      }
      expect(toolCallMsg.content).toBeNull();
      expect(toolCallMsg.tool_calls).toHaveLength(1);
      expect(toolCallMsg.tool_calls?.[0]?.id).toBe('call-123');
      expect(toolCallMsg.tool_calls?.[0]?.function.name).toBe('get_weather');

      // Tool result message
      const toolResultMsg = messages[2];
      expect(toolResultMsg?.role).toBe('tool');
      if (
        !toolResultMsg ||
        toolResultMsg.role !== 'tool' ||
        !('tool_call_id' in toolResultMsg)
      ) {
        throw new Error('Expected tool result message with tool_call_id');
      }
      expect(toolResultMsg.tool_call_id).toBe('call-123');
    });

    it('converts multi-modal content', () => {
      const conv = createMultiModalConversation();
      const messages = toOpenAIMessages(conv);

      expect(messages).toHaveLength(2);
      const userMsg = messages[0];
      expect(Array.isArray(userMsg?.content)).toBe(true);
      expect((userMsg?.content as any)[0]).toEqual({
        type: 'text',
        text: 'What is in this image?',
      });
      expect((userMsg?.content as any)[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.jpg' },
      });
    });

    it('collapses single text parts into a string', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: [{ type: 'text', text: 'Solo' }] },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('Solo');
    });

    it('returns empty string for text-only conversion with no parts', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'assistant',
          content: [{ type: 'image', url: 'https://example.com/only-image.png' }],
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('assistant');
      expect(messages[0]?.content).toBe('');
    });

    it('skips hidden messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Visible' },
        { role: 'user', content: 'Hidden', hidden: true },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('Visible');
    });

    it('maps developer role to system', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'developer', content: 'Developer instructions' },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages[0]?.role).toBe('system');
    });

    it('skips tool-use messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-use', content: '' }, // No toolCall
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('skips tool-result messages without toolResult', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-result', content: '' }, // No toolResult
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('skips snapshot messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'snapshot', content: 'snapshot data' },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('handles tool results with string content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'success',
            content: 'String result', // String content, not object
          },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe('String result');
    });

    it('does not emit tool results without matching tool calls after truncation', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Run tool' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
        },
        testEnvironment,
      );

      const truncated = truncateToTokenLimit(
        conv,
        1,
        { estimateTokens: simpleTokenEstimator, preserveLastN: 1 },
        testEnvironment,
      );
      const messages = toOpenAIMessages(truncated);

      const toolCallIds = new Set<string>();
      for (const message of messages) {
        if (message.role === 'assistant' && message.tool_calls) {
          for (const call of message.tool_calls) {
            toolCallIds.add(call.id);
          }
        }
      }

      for (const message of messages) {
        if (message.role === 'tool') {
          expect(toolCallIds.has(message.tool_call_id)).toBe(true);
        }
      }
    });

    it('rejects unknown roles before adapter formatting', () => {
      const conv = createConversation({ id: 'test' }, testEnvironment);
      expect(() =>
        // @ts-expect-error - testing runtime behavior for invalid role
        appendMessages(conv, { role: 'unknown', content: 'blah' }, testEnvironment),
      ).toThrow(ConversationalistError);
    });
  });

  describe('toOpenAIMessagesGrouped', () => {
    it('groups consecutive tool calls into single message', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do two things' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-2', name: 'tool_two', arguments: '{}' },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv);

      // Should be: user, assistant (with 2 tool_calls)
      expect(messages).toHaveLength(2);
      const groupedToolCalls = messages[1];
      if (
        !groupedToolCalls ||
        groupedToolCalls.role !== 'assistant' ||
        !('tool_calls' in groupedToolCalls)
      ) {
        throw new Error('Expected grouped tool calls');
      }
      expect(groupedToolCalls.tool_calls).toHaveLength(2);
    });

    it('flushes pending tool calls before different message type', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'done' },
        },
        { role: 'assistant', content: 'Done!' },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv);

      // Should be: user, assistant (with tool_calls), tool, assistant
      expect(messages).toHaveLength(4);
      const groupedToolCall = messages[1];
      expect(groupedToolCall?.role).toBe('assistant');
      if (
        !groupedToolCall ||
        groupedToolCall.role !== 'assistant' ||
        !('tool_calls' in groupedToolCall)
      ) {
        throw new Error('Expected grouped tool call');
      }
      expect(groupedToolCall.tool_calls).toHaveLength(1);
    });

    it('skips hidden messages in grouped mode', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Visible' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
          hidden: true,
        },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv);
      expect(messages).toHaveLength(1);
    });
  });
});

describe('Adapter integrity enforcement', () => {
  const assertIntegrityError = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationalistError);
      expect((error as ConversationalistError).code).toBe('error:integrity');
      return;
    }
    throw new Error('expected integrity error');
  };

  it('rejects broken tool linkage across adapters', () => {
    const conv = createBrokenToolConversation();
    assertIntegrityError(() => toOpenAIMessages(conv));
    assertIntegrityError(() => toOpenAIMessagesGrouped(conv));
    assertIntegrityError(() => toAnthropicMessages(conv));
    assertIntegrityError(() => toGeminiMessages(conv));
  });
});

describe('Anthropic Adapter', () => {
  describe('toAnthropicMessages', () => {
    it('extracts system message separately', () => {
      const conv = createBasicConversation();
      const { system, messages } = toAnthropicMessages(conv);

      expect(system).toBe('You are a helpful assistant.');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[1]?.role).toBe('assistant');
    });

    it('converts tool calls to tool_use blocks', () => {
      const conv = createToolCallConversation();
      const { messages } = toAnthropicMessages(conv);

      // Find the assistant message with tool_use
      const assistantMsg = messages.find(
        (m) => m.role === 'assistant' && Array.isArray(m.content),
      );
      expect(assistantMsg).toBeDefined();

      const toolUseBlock = (assistantMsg?.content as any[])?.find(
        (b: any) => b.type === 'tool_use',
      );
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.name).toBe('get_weather');
      expect(toolUseBlock.id).toBe('call-123');
    });

    it('converts tool results to tool_result blocks', () => {
      const conv = createToolCallConversation();
      const { messages } = toAnthropicMessages(conv);

      // Tool results go in user messages for Anthropic
      const userMsgWithResult = messages.find(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          (m.content as any[]).some((b: any) => b.type === 'tool_result'),
      );
      expect(userMsgWithResult).toBeDefined();
    });

    it('merges consecutive same-role messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Part 1' },
        { role: 'user', content: 'Part 2' },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);

      // Should be merged into one user message with content blocks
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('handles multi-modal content with base64 images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const content = messages[0]?.content as any[];

      expect(content).toHaveLength(2);
      expect(content[1].type).toBe('image');
      expect(content[1].source.type).toBe('base64');
    });

    it('handles multi-modal content with URL images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', url: 'https://example.com/image.jpg' },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const content = messages[0]?.content as any[];

      expect(content).toHaveLength(2);
      expect(content[1].type).toBe('image');
      expect(content[1].source.type).toBe('url');
      expect(content[1].source.url).toBe('https://example.com/image.jpg');
    });

    it('handles tool results with error outcome', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'error',
            content: 'Something went wrong',
          },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const userMsg = messages.find(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          (m.content as any[]).some((b: any) => b.type === 'tool_result'),
      );
      const toolResult = (userMsg?.content as any[]).find(
        (b: any) => b.type === 'tool_result',
      );
      expect(toolResult.is_error).toBe(true);
    });

    it('handles multi-modal system message content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
        },
        { role: 'user', content: 'Hello' },
        testEnvironment,
      );

      const { system, messages } = toAnthropicMessages(conv);
      expect(system).toBe('Part 1\n\nPart 2');
      expect(messages).toHaveLength(1);
    });

    it('handles assistant multi-modal content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Response part 1' },
            { type: 'text', text: 'Response part 2' },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      expect(messages).toHaveLength(2);
      const assistantMsg = messages[1];
      expect(Array.isArray(assistantMsg?.content)).toBe(true);
      expect((assistantMsg?.content as any[]).length).toBe(2);
    });

    it('handles tool call with object arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = (assistantMsg?.content as any[]).find(
        (b: any) => b.type === 'tool_use',
      );
      expect(toolUse.input).toEqual({ key: 'value' });
    });

    it('skips tool-use messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-use', content: '' },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('falls back to raw arguments for invalid JSON tool calls', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{invalid' },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = (assistantMsg?.content as any[]).find(
        (b: any) => b.type === 'tool_use',
      );
      expect(toolUse.input).toBe('{invalid');
    });

    it('handles data URLs with missing parts', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [{ type: 'image', url: 'data:image/png;base64' }], // Invalid data URL
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      // If content becomes empty, the message might be skipped or have empty content
      if (messages.length > 0) {
        expect(messages[0].content).toEqual([]);
      } else {
        expect(messages).toHaveLength(0);
      }
    });

    it('rejects unknown roles before adapter formatting', () => {
      const conv = createConversation({ id: 'test' }, testEnvironment);
      expect(() =>
        // @ts-expect-error - testing runtime behavior for invalid role
        appendMessages(conv, { role: 'unknown', content: 'blah' }, testEnvironment),
      ).toThrow(ConversationalistError);
    });
  });
});

describe('Gemini Adapter', () => {
  describe('toGeminiMessages', () => {
    it('extracts system instruction separately', () => {
      const conv = createBasicConversation();
      const { systemInstruction, contents } = toGeminiMessages(conv);

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts[0]).toEqual({
        text: 'You are a helpful assistant.',
      });
      expect(contents).toHaveLength(2);
    });

    it('maps assistant to model role', () => {
      const conv = createBasicConversation();
      const { contents } = toGeminiMessages(conv);

      const assistantMsg = contents.find((c) =>
        c.parts.some((p: any) => p.text === 'Hi there! How can I help you?'),
      );
      expect(assistantMsg?.role).toBe('model');
    });

    it('converts tool calls to functionCall parts', () => {
      const conv = createToolCallConversation();
      const { contents } = toGeminiMessages(conv);

      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      expect(modelContent).toBeDefined();

      const functionCallPart = modelContent?.parts.find(
        (p: any) => 'functionCall' in p,
      ) as any;
      expect(functionCallPart.functionCall.name).toBe('get_weather');
    });

    it('converts tool results to functionResponse parts', () => {
      const conv = createToolCallConversation();
      const { contents } = toGeminiMessages(conv);

      const userContent = contents.find(
        (c) => c.role === 'user' && c.parts.some((p: any) => 'functionResponse' in p),
      );
      expect(userContent).toBeDefined();

      const responsePart = userContent?.parts.find(
        (p: any) => 'functionResponse' in p,
      ) as any;
      expect(responsePart.functionResponse.name).toBe('get_weather');
    });

    it('merges consecutive same-role messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Part 1' },
        { role: 'user', content: 'Part 2' },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);

      expect(contents).toHaveLength(1);
      expect(contents[0]?.parts).toHaveLength(2);
    });

    it('handles multi-modal content with inline data', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = contents[0]?.parts as any[];

      expect(parts).toHaveLength(2);
      expect(parts[1].inlineData).toBeDefined();
      expect(parts[1].inlineData.mimeType).toBe('image/png');
    });

    it('handles file URIs for images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            {
              type: 'image',
              url: 'https://example.com/image.jpg',
              mimeType: 'image/jpeg',
            },
          ],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = contents[0]?.parts as any[];

      expect(parts[0].fileData).toBeDefined();
      expect(parts[0].fileData.fileUri).toBe('https://example.com/image.jpg');
      expect(parts[0].fileData.mimeType).toBe('image/jpeg');
    });

    it('handles file URIs without mimeType', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [{ type: 'image', url: 'https://example.com/image.jpg' }],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = contents[0]?.parts as any[];

      expect(parts[0].fileData).toBeDefined();
      expect(parts[0].fileData.fileUri).toBe('https://example.com/image.jpg');
      expect(parts[0].fileData.mimeType).toBe('image/jpeg');
    });

    it('falls back to default mimeType when extension is unknown', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [{ type: 'image', url: 'http://localhost/image' }],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = contents[0]?.parts as any[];

      expect(parts[0].fileData).toBeDefined();
      expect(parts[0].fileData.mimeType).toBe('application/octet-stream');
    });

    it('handles tool call with invalid JSON arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'invalid json {' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find(
        (p: any) => 'functionCall' in p,
      ) as any;
      expect(functionCallPart.functionCall.args).toEqual({ _raw: 'invalid json {' });
    });

    it('skips tool-use messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-use', content: '' },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      expect(contents).toHaveLength(1);
      expect(contents[0]?.role).toBe('user');
    });

    it('wraps non-object parsed arguments in _value', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'true' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find(
        (p: any) => 'functionCall' in p,
      ) as any;
      expect(functionCallPart.functionCall.args).toEqual({ _value: true });
    });

    it('handles tool call with object arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find(
        (p: any) => 'functionCall' in p,
      ) as any;
      expect(functionCallPart.functionCall.args).toEqual({ key: 'value' });
    });

    it('wraps non-object arguments in _value', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 42 },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find(
        (p: any) => 'functionCall' in p,
      ) as any;
      expect(functionCallPart.functionCall.args).toEqual({ _value: 42 });
    });

    it('handles system message with empty content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'system', content: '' },
        { role: 'user', content: 'Hello' },
        testEnvironment,
      );

      const { systemInstruction, contents } = toGeminiMessages(conv);
      // Empty system message results in no systemInstruction
      expect(systemInstruction).toBeUndefined();
      expect(contents).toHaveLength(1);
    });

    it('wraps non-object tool results', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const userContent = contents.find(
        (c) => c.role === 'user' && c.parts.some((p: any) => 'functionResponse' in p),
      );
      const responsePart = userContent?.parts.find(
        (p: any) => 'functionResponse' in p,
      ) as any;
      expect(responsePart.functionResponse.response).toEqual({ result: 'ok' });
    });

    it('rejects tool results without matching tool calls', () => {
      const conv = createBrokenToolConversation();
      expect(() => toGeminiMessages(conv)).toThrow(ConversationalistError);
    });

    it('rejects unknown roles before adapter formatting', () => {
      const conv = createConversation({ id: 'test' }, testEnvironment);
      expect(() =>
        // @ts-expect-error - testing runtime behavior for invalid role
        appendMessages(conv, { role: 'unknown', content: 'blah' }, testEnvironment),
      ).toThrow(ConversationalistError);
    });

    it('handles data URLs with missing parts', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [{ type: 'image', url: 'data:image/png;base64' }], // Invalid data URL
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      if (contents.length > 0) {
        expect(contents[0].parts).toHaveLength(0);
      } else {
        expect(contents).toHaveLength(0);
      }
    });
  });
});
