import { describe, expect, it } from 'bun:test';

import { toAnthropicMessages } from '../src/adapters/anthropic';
import { fromGeminiMessages, toGeminiMessages } from '../src/adapters/gemini';
import { toOpenAIMessagesGrouped } from '../src/adapters/openai';
import {
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
  getMessages,
} from '../src/conversation/index';
import { createTestConversationEnvironment } from '../src/test';

describe('package-local structural interop', () => {
  it('formats structural tool calls and results for OpenAI and Anthropic', () => {
    const environment = createTestConversationEnvironment({
      identifiers: ['message-1', 'message-2', 'message-3'],
    });

    let conversation = createConversationHistory({ id: 'structural-loop' }, environment);
    conversation = appendUserMessage(conversation, 'What is the weather in Denver?', environment);
    conversation = appendToolCalls(
      conversation,
      [
        {
          id: 'call-1',
          name: 'get_weather',
          arguments: { location: 'Denver' },
        },
      ],
      environment,
    );
    conversation = appendToolResults(
      conversation,
      [
        {
          callId: 'call-1',
          toolCallId: 'call-1',
          toolName: 'get_weather',
          outcome: 'success',
          content: {
            location: 'Denver',
            temperatureF: 72,
            condition: 'sunny',
          },
          result: {
            location: 'Denver',
            temperatureF: 72,
            condition: 'sunny',
          },
        },
      ],
      environment,
    );

    const openAIMessages = toOpenAIMessagesGrouped(conversation);
    expect(openAIMessages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-1',
          function: {
            name: 'get_weather',
          },
        },
      ],
    });
    expect(openAIMessages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    });

    const anthropicMessages = toAnthropicMessages(conversation);
    expect(anthropicMessages.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'get_weather',
        },
      ],
    });
    expect(anthropicMessages.messages[2]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
        },
      ],
    });
  });

  it('collects structural streaming tool results asynchronously for Gemini formatting', async () => {
    const environment = createTestConversationEnvironment({
      identifiers: ['message-1', 'message-2', 'message-3'],
    });

    let conversation = createConversationHistory({ id: 'stream-loop' }, environment);
    conversation = appendUserMessage(conversation, 'Stream the weather for Denver.', environment);
    conversation = appendToolCalls(
      conversation,
      [
        {
          id: 'call-stream',
          name: 'stream_weather',
          arguments: { location: 'Denver' },
        },
      ],
      environment,
    );
    conversation = await appendToolResultsAsync(
      conversation,
      [
        {
          callId: 'call-stream',
          toolCallId: 'call-stream',
          toolName: 'stream_weather',
          outcome: 'success',
          content: undefined,
          result: {
            async *[Symbol.asyncIterator]() {
              yield 'Denver:72F';
              yield 'sunny';
            },
          },
          stream: {
            async *[Symbol.asyncIterator]() {
              yield 'Denver:72F';
              yield 'sunny';
            },
          },
        },
      ],
      environment,
    );

    const geminiMessages = toGeminiMessages(conversation);
    expect(geminiMessages.contents[1]).toMatchObject({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'stream_weather',
            args: { location: 'Denver' },
          },
        },
      ],
    });
    expect(geminiMessages.contents[2]).toMatchObject({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'stream_weather',
            response: ['Denver:72F', 'sunny'],
          },
        },
      ],
    });

    const reconstructed = fromGeminiMessages(geminiMessages);
    expect(getMessages(reconstructed).map((message) => message.role)).toEqual([
      'user',
      'tool-call',
      'tool-result',
    ]);
  });
});
