import { describe, expect, it } from 'bun:test';

import {
  type AnthropicConversation,
  anthropicConversationAdapter,
  appendAnthropicMessages,
  fromAnthropicMessages,
  toAnthropicMessages,
} from '../src/adapters/anthropic';
import {
  appendGeminiMessages,
  fromGeminiMessages,
  type GeminiConversation,
  geminiConversationAdapter,
  toGeminiMessages,
} from '../src/adapters/gemini';
import {
  appendOpenAIMessages,
  fromOpenAIMessages,
  openAIConversationAdapter,
  type OpenAIMessage,
  toOpenAIMessages,
  toOpenAIMessagesGrouped,
} from '../src/adapters/openai';
import { createConversationHistory } from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import { Conversation } from '../src/history';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('provider reverse conversion', () => {
  it('reconstructs OpenAI messages into canonical tool interactions', () => {
    const payload: OpenAIMessage[] = [
      {
        role: 'system',
        content: 'You are helpful.',
      },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Denver' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({
          outcome: 'action_required',
          content: { prompt: 'Approve tool' },
          action: { type: 'approval', message: 'Need approval' },
        }),
      },
    ];

    const conversation = fromOpenAIMessages(payload);
    const messages = getOrderedMessages(conversation);

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
    ]);
    expect(messages[1]?.content).toBe('Let me check.');
    expect(messages[2]?.toolCall).toEqual({
      id: 'call-1',
      name: 'lookup_weather',
      arguments: { city: 'Denver' },
    });
    expect(messages[3]?.toolResult).toMatchObject({
      callId: 'call-1',
      outcome: 'action_required',
      content: { prompt: 'Approve tool' },
      action: { type: 'approval', message: 'Need approval' },
    });
  });

  it('reconstructs OpenAI null, multimodal, and fallback payload variants', () => {
    const payload: OpenAIMessage[] = [
      {
        role: 'system',
        content: null,
      },
      {
        role: 'user',
        content: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Single text part' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'See this image' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/weather-map.png' },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-invalid',
            type: 'function',
            function: {
              name: 'invalid_args',
              arguments: '{not-json',
            },
          },
          {
            id: 'call-digest',
            type: 'function',
            function: {
              name: 'digest_payload',
              arguments: JSON.stringify({ ok: true }),
            },
          },
          {
            id: 'call-array',
            type: 'function',
            function: {
              name: 'array_payload',
              arguments: JSON.stringify(['x', 'y']),
            },
          },
          {
            id: 'call-raw',
            type: 'function',
            function: {
              name: 'raw_payload',
              arguments: JSON.stringify({ raw: true }),
            },
          },
          {
            id: 'call-parts',
            type: 'function',
            function: {
              name: 'parts_payload',
              arguments: JSON.stringify({ parts: true }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-digest',
        content: JSON.stringify({
          outcome: 'error',
          content: { reason: 'denied' },
          error: {
            code: 'DENIED',
            category: 'permission',
            retryable: false,
            message: 'Permission denied',
          },
          inputDigest: 'input-digest',
          outputDigest: 'output-digest',
        }),
      },
      {
        role: 'tool',
        tool_call_id: 'call-array',
        content: JSON.stringify(['fallback', 'array']),
      },
      {
        role: 'tool',
        tool_call_id: 'call-raw',
        content: 'plain text fallback',
      },
      {
        role: 'tool',
        tool_call_id: 'call-parts',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      },
    ];

    const conversation = fromOpenAIMessages(payload);
    const messages = getOrderedMessages(conversation);
    const toolCalls = messages.filter((message) => message.role === 'tool-call');
    const toolResults = messages.filter((message) => message.role === 'tool-result');

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'assistant',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-result',
      'tool-result',
      'tool-result',
    ]);
    expect(messages[0]?.content).toBe('');
    expect(messages[1]?.content).toBe('');
    expect(messages[2]?.content).toBe('Single text part');
    expect(messages[3]?.content).toEqual([
      { type: 'text', text: 'See this image' },
      { type: 'image', url: 'https://example.com/weather-map.png' },
    ]);
    expect(toolCalls[0]?.toolCall).toEqual({
      id: 'call-invalid',
      name: 'invalid_args',
      arguments: '{not-json',
    });
    expect(toolResults[0]?.toolResult).toMatchObject({
      callId: 'call-digest',
      outcome: 'error',
      content: { reason: 'denied' },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
    });
    expect(toolResults[1]?.toolResult).toEqual({
      callId: 'call-array',
      outcome: 'success',
      content: ['fallback', 'array'],
    });
    expect(toolResults[2]?.toolResult).toEqual({
      callId: 'call-raw',
      outcome: 'success',
      content: 'plain text fallback',
    });
    expect(toolResults[3]?.toolResult).toEqual({
      callId: 'call-parts',
      outcome: 'success',
      content: 'line one\n\nline two',
    });
  });

  it('reconstructs Anthropic mixed blocks in original order', () => {
    const payload: AnthropicConversation = {
      system: 'Top-level system prompt',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I need to call a tool.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'lookup_weather',
              input: { city: 'Denver' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: JSON.stringify({
                outcome: 'error',
                content: { city: 'Denver' },
                error: {
                  code: 'TEMP_DOWN',
                  category: 'transient',
                  retryable: true,
                  message: 'Temporary outage',
                },
              }),
              is_error: true,
            },
            { type: 'text', text: 'Please try again.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const messages = getOrderedMessages(conversation);

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
      'user',
    ]);
    expect(messages[2]?.toolCall).toEqual({
      id: 'tool-1',
      name: 'lookup_weather',
      arguments: { city: 'Denver' },
    });
    expect(messages[3]?.toolResult).toMatchObject({
      callId: 'tool-1',
      outcome: 'error',
      content: { city: 'Denver' },
      error: {
        code: 'TEMP_DOWN',
        category: 'transient',
        retryable: true,
        message: 'Temporary outage',
      },
    });
    expect(messages[4]?.content).toBe('Please try again.');
  });

  it('reconstructs Anthropic multimodal and coerced tool payloads', () => {
    const payload: AnthropicConversation = {
      system: 'System prompt',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/chart.png',
              },
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'YWJjMTIz',
              },
            },
            {
              type: 'tool_use',
              id: 'tool-array',
              name: 'complex_input',
              input: {
                nested: [1, { flag: true }],
                strange: Symbol('anthropic') as unknown as string,
                huge: BigInt(4) as unknown as number,
                handler: (() => 'ok') as unknown as string,
              },
            },
            {
              type: 'tool_use',
              id: 'tool-fallback',
              name: 'fallback_input',
              input: ['x', { y: 2 }],
            },
            {
              type: 'tool_use',
              id: 'tool-raw',
              name: 'raw_input',
              input: { raw: true },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-array',
              content: JSON.stringify({
                outcome: 'action_required',
                content: { approval: true },
                action: { type: 'approval', message: 'Approve this tool call' },
                inputDigest: 'anthropic-input',
                outputDigest: 'anthropic-output',
              }),
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-fallback',
              content: JSON.stringify(['fallback', 'array']),
              is_error: true,
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-raw',
              content: 'plain text fallback',
            },
            { type: 'text', text: 'Please continue.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const messages = getOrderedMessages(conversation);
    const toolCalls = messages.filter((message) => message.role === 'tool-call');
    const toolResults = messages.filter((message) => message.role === 'tool-result');

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-result',
      'tool-result',
      'user',
    ]);
    // The two consecutive images in one Anthropic message group into a single
    // ordered multi-part assistant message, preserving block order.
    expect(messages[1]?.content).toEqual([
      { type: 'image', url: 'https://example.com/chart.png' },
      {
        type: 'image',
        url: 'data:image/png;base64,YWJjMTIz',
        mimeType: 'image/png',
      },
    ]);
    expect(toolCalls[0]?.toolCall).toMatchObject({
      id: 'tool-array',
      name: 'complex_input',
      arguments: {
        nested: [1, { flag: true }],
        strange: 'Symbol(anthropic)',
        huge: '4',
      },
    });
    expect(typeof (toolCalls[0]?.toolCall?.arguments as Record<string, unknown>)['handler']).toBe(
      'string',
    );
    expect(toolCalls[1]?.toolCall).toEqual({
      id: 'tool-fallback',
      name: 'fallback_input',
      arguments: ['x', { y: 2 }],
    });
    expect(toolCalls[2]?.toolCall).toEqual({
      id: 'tool-raw',
      name: 'raw_input',
      arguments: { raw: true },
    });
    expect(toolResults[0]?.toolResult).toMatchObject({
      callId: 'tool-array',
      outcome: 'action_required',
      content: { approval: true },
      action: { type: 'approval', message: 'Approve this tool call' },
      inputDigest: 'anthropic-input',
      outputDigest: 'anthropic-output',
    });
    expect(toolResults[1]?.toolResult).toEqual({
      callId: 'tool-fallback',
      outcome: 'error',
      content: ['fallback', 'array'],
    });
    expect(toolResults[2]?.toolResult).toEqual({
      callId: 'tool-raw',
      outcome: 'success',
      content: 'plain text fallback',
    });
    expect(messages[8]?.content).toBe('Please continue.');
  });

  it('reconstructs Gemini function calls and pairs synthetic call IDs', () => {
    const payload: GeminiConversation = {
      systemInstruction: {
        role: 'user',
        parts: [{ text: 'You are helpful.' }],
      },
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'Checking the weather.' },
            {
              functionCall: {
                name: 'lookup_weather',
                args: { city: 'Denver' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { forecast: 'sunny' } },
              },
            },
            { text: 'Thanks!' },
          ],
        },
      ],
    };

    const conversation = fromGeminiMessages(payload);
    const messages = getOrderedMessages(conversation);
    const toolCall = messages.find((message) => message.role === 'tool-call');
    const toolResult = messages.find((message) => message.role === 'tool-result');

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
      'user',
    ]);
    expect(toolCall?.toolCall?.id).toMatch(/^gemini-call-\d+$/);
    expect(toolCall?.toolCall?.arguments).toEqual({ city: 'Denver' });
    expect(toolResult?.toolResult).toMatchObject({
      callId: toolCall?.toolCall?.id,
      outcome: 'success',
      content: { forecast: 'sunny' },
    });
  });

  it('reconstructs Gemini multimodal payloads, wrappers, and orphan responses', () => {
    const payload: GeminiConversation = {
      systemInstruction: {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'c3lzdGVtLWltYWdl',
            },
          },
          {
            fileData: {
              fileUri: 'gs://bucket/system-reference.png',
              mimeType: 'image/png',
            },
          },
        ],
      },
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'unwrap_value',
                args: { _value: [1, { ok: true }] },
              },
            },
            {
              functionCall: {
                name: 'raw_args',
                args: { _raw: 'not-json' },
              },
            },
            {
              functionCall: {
                name: 'stringified',
                args: {
                  weird: BigInt(5) as unknown as number,
                  nested: [Symbol('gemini') as unknown as string],
                },
              },
            },
            {
              functionCall: {
                name: 'array_response',
                args: {},
              },
            },
            { text: 'hello from model' },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: 'bW9kZWwtaW1hZ2U=',
              },
            },
            {
              fileData: {
                fileUri: 'gs://bucket/model-reference.jpg',
                mimeType: 'image/jpeg',
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'unwrap_value',
                response: {
                  outcome: 'action_required',
                  content: { approval: true },
                  action: { type: 'input', message: 'Provide confirmation' },
                  inputDigest: 'gemini-input',
                  outputDigest: 'gemini-output',
                },
              },
            },
            {
              functionResponse: {
                name: 'raw_args',
                response: { result: ['ok'] },
              },
            },
            {
              functionResponse: {
                name: 'stringified',
                response: {
                  status: 'done',
                  weird: BigInt(7) as unknown as number,
                },
              },
            },
            {
              functionResponse: {
                name: 'array_response',
                response: ['not', 'canonical'] as unknown as Record<string, unknown>,
              },
            },
            { text: 'thanks' },
          ],
        },
      ],
    };

    const conversation = fromGeminiMessages(payload);
    const messages = getOrderedMessages(conversation);
    const toolCalls = messages.filter((message) => message.role === 'tool-call');
    const toolResults = messages.filter((message) => message.role === 'tool-result');

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-call',
      'assistant',
      'assistant',
      'assistant',
      'tool-result',
      'tool-result',
      'tool-result',
      'tool-result',
      'user',
    ]);
    expect(messages[0]?.content).toEqual([
      {
        type: 'image',
        url: 'data:image/png;base64,c3lzdGVtLWltYWdl',
        mimeType: 'image/png',
      },
      {
        type: 'image',
        url: 'gs://bucket/system-reference.png',
        mimeType: 'image/png',
      },
    ]);
    expect(toolCalls[0]?.toolCall).toEqual({
      id: 'gemini-call-1',
      name: 'unwrap_value',
      arguments: [1, { ok: true }],
    });
    expect(toolCalls[1]?.toolCall).toEqual({
      id: 'gemini-call-2',
      name: 'raw_args',
      arguments: 'not-json',
    });
    expect(toolCalls[2]?.toolCall).toEqual({
      id: 'gemini-call-3',
      name: 'stringified',
      arguments: {
        weird: '5',
        nested: ['Symbol(gemini)'],
      },
    });
    expect(toolCalls[3]?.toolCall).toEqual({
      id: 'gemini-call-4',
      name: 'array_response',
      arguments: {},
    });
    expect(messages[5]?.content).toBe('hello from model');
    expect(messages[6]?.content).toEqual([
      {
        type: 'image',
        url: 'data:image/jpeg;base64,bW9kZWwtaW1hZ2U=',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(messages[7]?.content).toEqual([
      {
        type: 'image',
        url: 'gs://bucket/model-reference.jpg',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(toolResults[0]?.toolResult).toMatchObject({
      callId: 'gemini-call-1',
      outcome: 'action_required',
      content: { approval: true },
      action: { type: 'input', message: 'Provide confirmation' },
      inputDigest: 'gemini-input',
      outputDigest: 'gemini-output',
    });
    expect(toolResults[1]?.toolResult).toEqual({
      callId: 'gemini-call-2',
      outcome: 'success',
      content: ['ok'],
    });
    expect(toolResults[2]?.toolResult).toEqual({
      callId: 'gemini-call-3',
      outcome: 'success',
      content: {
        status: 'done',
        weird: '7',
      },
    });
    expect(toolResults[3]?.toolResult).toEqual({
      callId: 'gemini-call-4',
      outcome: 'success',
      content: ['not', 'canonical'],
    });
    expect(messages[12]?.content).toBe('thanks');
  });

  it('rejects orphan Gemini function responses that cannot be linked to a tool call', () => {
    expect(() =>
      fromGeminiMessages({
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'no_call_yet',
                  response: { status: 'orphan' },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(ConversationalistError);
  });

  it('matches repeated Gemini function responses in queue order', () => {
    const conversation = fromGeminiMessages({
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'lookup_weather',
                args: { city: 'Denver' },
              },
            },
            {
              functionCall: {
                name: 'lookup_weather',
                args: { city: 'Boulder' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { city: 'Denver' } },
              },
            },
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { city: 'Boulder' } },
              },
            },
          ],
        },
      ],
    });

    const toolResults = getOrderedMessages(conversation).filter(
      (message) => message.role === 'tool-result',
    );

    expect(toolResults.map((message) => message.toolResult?.callId)).toEqual([
      'gemini-call-1',
      'gemini-call-2',
    ]);
    expect(toolResults.map((message) => message.toolResult?.content)).toEqual([
      { city: 'Denver' },
      { city: 'Boulder' },
    ]);
  });

  it('omits an empty Gemini system instruction when it has no parts', () => {
    const conversation = fromGeminiMessages({
      systemInstruction: {
        role: 'user',
        parts: [],
      },
      contents: [],
    });

    expect(conversation.ids).toHaveLength(0);
  });
});

describe('Conversation lazy provider helpers', () => {
  it('supports the generic fromProvider, toProvider, and appendProvider helpers', async () => {
    const payload: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Let me call a tool.',
        tool_calls: [
          {
            id: 'call-generic',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Denver' }),
            },
          },
        ],
      },
    ];

    const conversation = await Conversation.fromProvider('openai', payload);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool-call',
    ]);

    await expect(conversation.toProvider('openai', { groupToolCalls: true })).resolves.toEqual(
      toOpenAIMessagesGrouped(conversation.current),
    );

    const appendedConversation = new Conversation();
    await appendedConversation.appendProvider('openai', payload);
    expect(getOrderedMessages(appendedConversation.current).map((message) => message.role)).toEqual(
      ['user', 'assistant', 'tool-call'],
    );
  });

  it('imports from and exports to OpenAI lazily', async () => {
    const payload: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const conversation = await Conversation.fromOpenAIMessages(payload);
    const standalone = fromOpenAIMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    await expect(conversation.toOpenAIMessages()).resolves.toEqual(
      toOpenAIMessages(conversation.current),
    );
    await expect(conversation.toOpenAIMessagesGrouped()).resolves.toEqual(
      toOpenAIMessagesGrouped(conversation.current),
    );
  });

  it('imports from and exports to Anthropic lazily', async () => {
    const payload: AnthropicConversation = {
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const conversation = await Conversation.fromAnthropicMessages(payload);
    const standalone = fromAnthropicMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    await expect(conversation.toAnthropicMessages()).resolves.toEqual(
      toAnthropicMessages(conversation.current),
    );
  });

  it('imports from and exports to Gemini lazily', async () => {
    const payload: GeminiConversation = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };

    const conversation = await Conversation.fromGeminiMessages(payload);
    const standalone = fromGeminiMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    await expect(conversation.toGeminiMessages()).resolves.toEqual(
      toGeminiMessages(conversation.current),
    );
  });

  it('appends provider payloads through the direct adapter helpers', () => {
    const openAIConversation = appendOpenAIMessages(createConversationHistory(), [
      { role: 'user', content: 'Hello from OpenAI' },
    ]);
    expect(getOrderedMessages(openAIConversation)[0]?.content).toBe('Hello from OpenAI');
    expect(appendOpenAIMessages(openAIConversation, [])).toBe(openAIConversation);
    expect(
      getOrderedMessages(
        openAIConversationAdapter.append(createConversationHistory(), [
          { role: 'assistant', content: 'Adapter append' },
        ]),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(
        fromOpenAIMessages([{ role: 'assistant', content: 'Adapter append' }]),
      ).map((message) => message.content),
    );

    const anthropicPayload: AnthropicConversation = {
      messages: [{ role: 'user', content: 'Hello from Anthropic' }],
    };
    const anthropicConversation = appendAnthropicMessages(
      createConversationHistory(),
      anthropicPayload,
    );
    expect(getOrderedMessages(anthropicConversation)[0]?.content).toBe('Hello from Anthropic');
    const emptyAnthropicConversation = createConversationHistory();
    expect(appendAnthropicMessages(emptyAnthropicConversation, { messages: [] })).toBe(
      emptyAnthropicConversation,
    );
    expect(
      getOrderedMessages(
        anthropicConversationAdapter.append(createConversationHistory(), anthropicPayload),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(fromAnthropicMessages(anthropicPayload)).map((message) => message.content),
    );

    const geminiPayload: GeminiConversation = {
      contents: [{ role: 'user', parts: [{ text: 'Hello from Gemini' }] }],
    };
    const geminiConversation = appendGeminiMessages(createConversationHistory(), geminiPayload);
    expect(getOrderedMessages(geminiConversation)[0]?.content).toBe('Hello from Gemini');
    const emptyGeminiConversation = createConversationHistory();
    expect(appendGeminiMessages(emptyGeminiConversation, { contents: [] })).toBe(
      emptyGeminiConversation,
    );
    expect(
      getOrderedMessages(
        geminiConversationAdapter.append(createConversationHistory(), geminiPayload),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(fromGeminiMessages(geminiPayload)).map((message) => message.content),
    );
  });
});
