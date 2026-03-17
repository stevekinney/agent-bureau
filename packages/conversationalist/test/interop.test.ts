import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  parseAnthropicToolCalls,
  toAnthropicTools,
} from '../../armorer/src/adapters/anthropic/index';
import {
  parseGeminiToolCalls,
  toGeminiTools,
} from '../../armorer/src/adapters/gemini/index';
import {
  parseOpenAIToolCalls,
  toOpenAITools,
} from '../../armorer/src/adapters/openai/index';
import { createTool, createToolbox } from '../../armorer/src/index';
import { toAnthropicMessages } from '../src/adapters/anthropic';
import { toGeminiMessages } from '../src/adapters/gemini';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai';
import {
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
  appendUserMessage,
  createConversation,
} from '../src/conversation/index';
import { createTestConversationEnvironment } from '../src/test';

function createWeatherToolbox() {
  return createToolbox([
    createTool({
      name: 'get_weather',
      description: 'Get weather for a location',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => ({
        location,
        temperatureF: 72,
        condition: 'sunny',
      }),
    }),
    createTool({
      name: 'stream_weather',
      description: 'Stream weather status for a location',
      input: z.object({ location: z.string() }),
      async execute({ location }) {
        return {
          async *[Symbol.asyncIterator]() {
            yield `${location}:72F`;
            yield 'sunny';
          },
        };
      },
    }),
  ]);
}

describe('armorer and conversationalist interop', () => {
  it('runs the canonical OpenAI tool loop', async () => {
    const toolbox = createWeatherToolbox();
    const environment = createTestConversationEnvironment({
      identifiers: ['message-1', 'message-2', 'message-3'],
    });

    let conversation = createConversation({ id: 'openai-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'What is the weather in Denver?',
      environment,
    );

    expect(toOpenAIMessages(conversation)).toEqual([
      { role: 'user', content: 'What is the weather in Denver?' },
    ]);

    const tools = toOpenAITools(toolbox);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0]?.function.name).toBe('get_weather');

    const toolCalls = parseOpenAIToolCalls([
      {
        id: 'call-openai-1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Denver"}',
        },
      },
    ]);

    conversation = appendToolCalls(conversation, toolCalls, environment);
    const results = await toolbox.execute(toolCalls);
    conversation = appendToolResults(conversation, results, environment);

    const messages = toOpenAIMessagesGrouped(conversation);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-openai-1',
          function: {
            name: 'get_weather',
          },
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-openai-1',
    });
    expect((messages[2] as { content: string }).content).toContain('"temperatureF":72');
  });

  it('runs the canonical Anthropic tool loop', async () => {
    const toolbox = createWeatherToolbox();
    const environment = createTestConversationEnvironment({
      identifiers: ['message-1', 'message-2', 'message-3'],
    });

    let conversation = createConversation({ id: 'anthropic-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Use the weather tool for Denver.',
      environment,
    );

    const initial = toAnthropicMessages(conversation);
    expect(initial.messages).toEqual([
      { role: 'user', content: 'Use the weather tool for Denver.' },
    ]);

    const tools = toAnthropicTools(toolbox);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0]?.name).toBe('get_weather');

    const toolCalls = parseAnthropicToolCalls([
      {
        type: 'tool_use',
        id: 'call-anthropic-1',
        name: 'get_weather',
        input: { location: 'Denver' },
      },
    ]);

    conversation = appendToolCalls(conversation, toolCalls, environment);
    const results = await toolbox.execute(toolCalls);
    conversation = appendToolResults(conversation, results, environment);

    const formatted = toAnthropicMessages(conversation);
    expect(formatted.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call-anthropic-1',
          name: 'get_weather',
        },
      ],
    });
    expect(formatted.messages[2]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-anthropic-1',
        },
      ],
    });
  });

  it('runs the canonical Gemini tool loop with streamed tool results', async () => {
    const toolbox = createWeatherToolbox();
    const environment = createTestConversationEnvironment({
      identifiers: ['message-1', 'message-2', 'message-3'],
    });

    let conversation = createConversation({ id: 'gemini-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Stream the weather for Denver.',
      environment,
    );

    const initial = toGeminiMessages(conversation);
    expect(initial.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Stream the weather for Denver.' }],
      },
    ]);

    const tools = toGeminiTools(toolbox);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.functionDeclarations[0]?.name).toBe('get_weather');

    const toolCalls = parseGeminiToolCalls([
      {
        functionCall: {
          name: 'stream_weather',
          args: { location: 'Denver' },
        },
      },
    ]).map((toolCall, index) => ({
      ...toolCall,
      id: `call-gemini-${index + 1}`,
    }));

    conversation = appendToolCalls(conversation, toolCalls, environment);
    const results = await toolbox.execute(toolCalls, { stream: true });
    conversation = await appendToolResultsAsync(conversation, results, environment);

    const formatted = toGeminiMessages(conversation);
    expect(formatted.contents[1]).toMatchObject({
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
    expect(formatted.contents[2]).toMatchObject({
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
  });
});
