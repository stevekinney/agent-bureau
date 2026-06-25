import { describe, expect, it } from 'bun:test';

import type { AnthropicConversation } from '../src/adapters/anthropic';
import { fromAnthropicMessages, toAnthropicMessages } from '../src/adapters/anthropic';
import { toGeminiMessages } from '../src/adapters/gemini';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai';
import { simpleTokenEstimator, truncateToTokenLimit } from '../src/context';
import {
  appendMessages,
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  createConversationHistoryUnsafe as createConversationUnsafe,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { appendStreamingMessage } from '../src/streaming';
import type { ConversationHistory as Conversation } from '../src/types';

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
      role: 'tool-call',
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
      if (!toolCallMsg || toolCallMsg.role !== 'assistant' || !('tool_calls' in toolCallMsg)) {
        throw new Error('Expected tool call message with tool_calls');
      }
      expect(toolCallMsg.content).toBeNull();
      expect(toolCallMsg.tool_calls).toHaveLength(1);
      expect(toolCallMsg.tool_calls?.[0]?.id).toBe('call-123');
      expect(toolCallMsg.tool_calls?.[0]?.function.name).toBe('get_weather');

      // Tool result message
      const toolResultMsg = messages[2];
      expect(toolResultMsg?.role).toBe('tool');
      if (!toolResultMsg || toolResultMsg.role !== 'tool' || !('tool_call_id' in toolResultMsg)) {
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

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' }, // No toolCall
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
          role: 'tool-call',
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

    it('includes error and action payloads for non-success tool results', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'action_required',
            content: 'Need approval',
            error: {
              code: 'tool.pending',
              category: 'permission',
              retryable: false,
              message: 'Approval required',
            },
            action: {
              type: 'approval',
              message: 'Approve this request',
            },
          },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage?.role).toBe('tool');
      if (!toolMessage || toolMessage.role !== 'tool') {
        throw new Error('Expected tool message');
      }

      expect(JSON.parse(toolMessage.content as string)).toEqual({
        outcome: 'action_required',
        content: 'Need approval',
        error: {
          code: 'tool.pending',
          category: 'permission',
          retryable: false,
          message: 'Approval required',
        },
        action: {
          type: 'approval',
          message: 'Approve this request',
        },
      });
    });

    it('does not emit tool results without matching tool calls after truncation', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Run tool' },
        {
          role: 'tool-call',
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
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-call',
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
          role: 'tool-call',
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
          role: 'tool-call',
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
      const assistantMsg = messages.find((m) => m.role === 'assistant' && Array.isArray(m.content));
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
          role: 'tool-call',
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
      const toolResult = (userMsg?.content as any[]).find((b: any) => b.type === 'tool_result');
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
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = (assistantMsg?.content as any[]).find((b: any) => b.type === 'tool_use');
      expect(toolUse.input).toEqual({ key: 'value' });
    });

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' },
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
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{invalid' },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = (assistantMsg?.content as any[]).find((b: any) => b.type === 'tool_use');
      expect(toolUse.input).toBe('{invalid');
    });

    it('preserves a data URL that does not match the base64 shape as a url source (does not silently drop it)', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          // `data:` prefix but not a valid `data:<media>;base64,<data>` URL.
          content: [{ type: 'image', url: 'data:image/png;base64' }],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      expect(messages).toHaveLength(1);
      const blocks = messages[0]?.content as any[];
      // The image must survive — as a url source — rather than vanishing from
      // the outgoing Anthropic payload.
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: 'image',
        source: { type: 'url', url: 'data:image/png;base64' },
      });
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

      const functionCallPart = modelContent?.parts.find((p: any) => 'functionCall' in p) as any;
      expect(functionCallPart.functionCall.name).toBe('get_weather');
    });

    it('converts tool results to functionResponse parts', () => {
      const conv = createToolCallConversation();
      const { contents } = toGeminiMessages(conv);

      const userContent = contents.find(
        (c) => c.role === 'user' && c.parts.some((p: any) => 'functionResponse' in p),
      );
      expect(userContent).toBeDefined();

      const responsePart = userContent?.parts.find((p: any) => 'functionResponse' in p) as any;
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
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'invalid json {' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find((p: any) => 'functionCall' in p) as any;
      expect(functionCallPart.functionCall.args).toEqual({ _raw: 'invalid json {' });
    });

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' },
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
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'true' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find((p: any) => 'functionCall' in p) as any;
      expect(functionCallPart.functionCall.args).toEqual({ _value: true });
    });

    it('handles tool call with object arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find((p: any) => 'functionCall' in p) as any;
      expect(functionCallPart.functionCall.args).toEqual({ key: 'value' });
    });

    it('wraps non-object arguments in _value', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 42 },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p: any) => 'functionCall' in p),
      );
      const functionCallPart = modelContent?.parts.find((p: any) => 'functionCall' in p) as any;
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
          role: 'tool-call',
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
      const responsePart = userContent?.parts.find((p: any) => 'functionResponse' in p) as any;
      expect(responsePart.functionResponse.response).toEqual({ result: 'ok' });
    });

    it('preserves error and action payloads for non-success tool results', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'action_required',
            content: 'Need approval',
            error: {
              code: 'tool.pending',
              category: 'permission',
              retryable: false,
              message: 'Approval required',
            },
            action: {
              type: 'approval',
              message: 'Approve this request',
            },
          },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const userContent = contents.find(
        (content) =>
          content.role === 'user' && content.parts.some((part: any) => 'functionResponse' in part),
      );
      const responsePart = userContent?.parts.find(
        (part: any) => 'functionResponse' in part,
      ) as any;

      expect(responsePart.functionResponse.response).toEqual({
        outcome: 'action_required',
        content: 'Need approval',
        error: {
          code: 'tool.pending',
          category: 'permission',
          retryable: false,
          message: 'Approval required',
        },
        action: {
          type: 'approval',
          message: 'Approve this request',
        },
      });
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

describe('Streaming message protection in adapters', () => {
  function createConversationWithStreamingMessage(): Conversation {
    let conv = createConversation({ id: 'streaming-test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      testEnvironment,
    );
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);
    return conversation;
  }

  it('OpenAI adapter skips streaming messages in ungrouped export', () => {
    const conv = createConversationWithStreamingMessage();
    const messages = toOpenAIMessages(conv);

    // Should only have user and assistant, not the streaming message
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('OpenAI adapter skips streaming messages in grouped export', () => {
    const conv = createConversationWithStreamingMessage();
    const messages = toOpenAIMessagesGrouped(conv);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('Anthropic adapter skips streaming messages', () => {
    const conv = createConversationWithStreamingMessage();
    const { messages } = toAnthropicMessages(conv);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('Gemini adapter skips streaming messages', () => {
    const conv = createConversationWithStreamingMessage();
    const { contents } = toGeminiMessages(conv);

    expect(contents).toHaveLength(2);
    expect(contents[0]?.role).toBe('user');
    expect(contents[1]?.role).toBe('model');
  });
});

describe('C5 — Server-tool content blocks (Anthropic adapter)', () => {
  it('round-trips server_tool_use and web_search_tool_result interleaved with text', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Search for recent news about AI' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search for that.' },
            {
              type: 'server_tool_use',
              id: 'stu_123',
              name: 'web_search',
              input: { query: 'recent AI news' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'stu_123',
              content: [
                { type: 'web_search_result', url: 'https://example.com', title: 'AI News' },
              ],
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is a summary of recent AI news.' }],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Should have user → assistant (server_tool_use) → user (web_search_result) → assistant
    expect(roundTripped.messages).toHaveLength(4);

    // Find assistant message with server_tool_use
    const assistantWithServerTool = roundTripped.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === 'server_tool_use'),
    );
    expect(assistantWithServerTool).toBeDefined();

    const serverToolBlock = (assistantWithServerTool?.content as any[]).find(
      (b: any) => b.type === 'server_tool_use',
    );
    expect(serverToolBlock).toBeDefined();
    expect(serverToolBlock.id).toBe('stu_123');
    expect(serverToolBlock.name).toBe('web_search');
    expect(serverToolBlock.input).toEqual({ query: 'recent AI news' });

    // Find user message with web_search_tool_result
    const userWithSearchResult = roundTripped.messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === 'web_search_tool_result'),
    );
    expect(userWithSearchResult).toBeDefined();

    const searchResultBlock = (userWithSearchResult?.content as any[]).find(
      (b: any) => b.type === 'web_search_tool_result',
    );
    expect(searchResultBlock).toBeDefined();
    expect(searchResultBlock.tool_use_id).toBe('stu_123');
  });

  it('round-trips [text, server_tool_use, text] as ONE assistant message with blocks in their original order', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Do a search' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching now.' },
            { type: 'server_tool_use', id: 'stu_a', name: 'web_search', input: { q: 'test' } },
            { type: 'text', text: 'Done searching.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Groupable blocks of one Anthropic turn must round-trip as a single
    // assistant message, not be fragmented across multiple messages.
    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = assistantMessages[0]?.content;
    expect(Array.isArray(blocks)).toBe(true);

    // Block TYPES must appear in exactly the original order.
    const typedBlocks = blocks as Array<{ type: string }>;
    expect(typedBlocks.map((b) => b.type)).toEqual(['text', 'server_tool_use', 'text']);

    // And the actual values must be preserved, not just the shape.
    const first = typedBlocks[0] as { type: 'text'; text: string };
    const middle = typedBlocks[1] as { type: 'server_tool_use'; id: string; name: string };
    const last = typedBlocks[2] as { type: 'text'; text: string };
    expect(first.text).toBe('Searching now.');
    expect(middle.id).toBe('stu_a');
    expect(middle.name).toBe('web_search');
    expect(last.text).toBe('Done searching.');
  });

  it('round-trips [thinking, server_tool_use, text] as one ordered assistant message (extended thinking + web search)', () => {
    // A realistic Anthropic pattern: the model thinks, invokes a server tool,
    // then answers. All three blocks are groupable, so they must stay together
    // in one ordered message with the thinking signature intact.
    const SIG = 'EqoBthinkSig==';
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Find todays news' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should search the web.', signature: SIG },
            { type: 'server_tool_use', id: 'stu_z', name: 'web_search', input: { q: 'news' } },
            { type: 'text', text: 'Let me look.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = assistantMessages[0]?.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'server_tool_use', 'text']);

    const thinking = blocks[0] as { type: 'thinking'; thinking: string; signature: string };
    expect(thinking.thinking).toBe('I should search the web.');
    // Signature survives the round-trip byte-for-byte even when not followed
    // immediately by a text block.
    expect(thinking.signature).toBe(SIG);
  });

  it('keeps a client tool_use interleaved between text blocks in true order across the round-trip', () => {
    // tool_use is role-bearing on import (a tool-call message), but every piece
    // of this turn is assistant-role on export, so toAnthropicMessages merges
    // the consecutive assistant messages back into one ordered block array.
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Look it up' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before.' },
            { type: 'tool_use', id: 'call-mid', name: 'lookup', input: { k: 'v' } },
            { type: 'text', text: 'After.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = assistantMessages[0]?.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);

    const first = blocks[0] as { type: 'text'; text: string };
    const mid = blocks[1] as { type: 'tool_use'; id: string; name: string; input: unknown };
    const last = blocks[2] as { type: 'text'; text: string };
    expect(first.text).toBe('Before.');
    expect(mid.id).toBe('call-mid');
    expect(mid.name).toBe('lookup');
    expect(mid.input).toEqual({ k: 'v' });
    expect(last.text).toBe('After.');
  });
});

describe('C3 — Extended-thinking content blocks (Anthropic adapter)', () => {
  const THINKING_SIGNATURE = 'EqoBCkgIARABGAIiQL8gy6bfP3E5example_signature==';
  const REDACTED_SIGNATURE = 'EqoBCkgIARRedactedSignature==';

  it('round-trips a thinking block through fromAnthropicMessages → toAnthropicMessages, preserving signature byte-for-byte', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me think... 2+2 is 4',
              signature: THINKING_SIGNATURE,
            },
            { type: 'text', text: 'The answer is 4.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Should have user and assistant messages
    expect(roundTripped.messages).toHaveLength(2);
    const assistantBlocks = roundTripped.messages[1]?.content;
    expect(Array.isArray(assistantBlocks)).toBe(true);

    const thinkingBlock = (assistantBlocks as any[]).find((b: any) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe('Let me think... 2+2 is 4');
    // Signature must be byte-for-byte identical
    expect(thinkingBlock.signature).toBe(THINKING_SIGNATURE);

    const textBlock = (assistantBlocks as any[]).find((b: any) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toBe('The answer is 4.');
  });

  it('round-trips a redacted_thinking block, preserving signature byte-for-byte', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Tell me something' },
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', signature: REDACTED_SIGNATURE },
            { type: 'text', text: 'Here is my response.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    expect(roundTripped.messages).toHaveLength(2);
    const assistantBlocks = roundTripped.messages[1]?.content;
    expect(Array.isArray(assistantBlocks)).toBe(true);

    const redactedBlock = (assistantBlocks as any[]).find(
      (b: any) => b.type === 'redacted_thinking',
    );
    expect(redactedBlock).toBeDefined();
    // Signature must be byte-for-byte identical
    expect(redactedBlock.signature).toBe(REDACTED_SIGNATURE);
  });

  it('preserves block order: thinking → text → tool_use in a round-trip', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should check weather', signature: THINKING_SIGNATURE },
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', id: 'call-weather', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-weather', content: '{"temp": 72}' }],
        },
        {
          role: 'assistant',
          content: 'The weather in NYC is 72°F.',
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Find the assistant message that has thinking + text blocks
    const assistantMsgWithThinking = roundTripped.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === 'thinking'),
    );
    expect(assistantMsgWithThinking).toBeDefined();

    const blocks = assistantMsgWithThinking?.content as any[];
    // Block order must be preserved
    expect(blocks[0]?.type).toBe('thinking');
    expect(blocks[0]?.signature).toBe(THINKING_SIGNATURE);
    expect(blocks[1]?.type).toBe('text');
  });

  it('does not drop thinking blocks during compaction / toAnthropicMessages export', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Summarize' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Internal reasoning here',
              signature: THINKING_SIGNATURE,
            },
            { type: 'text', text: 'Here is a summary.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    // Re-export should still have the thinking block
    const exported = toAnthropicMessages(conversation);
    const assistantContent = exported.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);

    const thinkingBlock = (assistantContent as any[]).find((b: any) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.signature).toBe(THINKING_SIGNATURE);
  });

  it('preserves a trailing thinking block that has no following text block', () => {
    // Exercises the flush of accumulated content at the end of a turn: an
    // assistant message whose only content is a thinking block.
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Think only' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Reasoning, no answer yet',
              signature: THINKING_SIGNATURE,
            },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantContent = roundTripped.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const thinkingBlock = (assistantContent as any[]).find((b: any) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe('Reasoning, no answer yet');
    expect(thinkingBlock.signature).toBe(THINKING_SIGNATURE);
  });

  it('preserves a trailing redacted_thinking block that has no following text block', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Redacted only' },
        {
          role: 'assistant',
          content: [{ type: 'redacted_thinking', signature: REDACTED_SIGNATURE }],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantContent = roundTripped.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const redactedBlock = (assistantContent as any[]).find(
      (b: any) => b.type === 'redacted_thinking',
    );
    expect(redactedBlock).toBeDefined();
    expect(redactedBlock.signature).toBe(REDACTED_SIGNATURE);
  });
});
