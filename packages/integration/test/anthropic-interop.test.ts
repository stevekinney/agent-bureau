import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer/adapters/anthropic';
import { describe, expect, expectTypeOf, it } from 'bun:test';
import {
  fromAnthropicMessages,
  toAnthropicMessagesForSdk,
} from 'conversationalist/adapters/anthropic';
import { appendUserMessage, createConversationHistory } from 'conversationalist/conversation';

describe('Anthropic SDK interoperability', () => {
  it('passes adapter values directly to the SDK and parses streamed content blocks', () => {
    let conversation = createConversationHistory({ title: 'Weather' });
    conversation = appendUserMessage(conversation, 'Use the weather tool for Denver.');

    const { system, messages } = toAnthropicMessagesForSdk(conversation);
    const tools = toAnthropicTools([]);

    const request: MessageCreateParamsNonStreaming = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      ...(system === undefined ? {} : { system }),
      messages,
      tools,
    };

    expect(request.messages).toBe(messages);
    expectTypeOf(messages).toExtend<MessageParam[]>();
    expectTypeOf(tools).toExtend<Tool[]>();

    const sdkToolWithoutProperties: Tool = {
      name: 'weather',
      description: 'Get the weather.',
      input_schema: { type: 'object', properties: null },
    };
    expect(sdkToolWithoutProperties.input_schema.properties).toBeNull();

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Calling a tool.', citations: null },
      { type: 'tool_use', id: 'toolu_123', name: 'weather', input: { city: 'Denver' } },
    ];

    expect(parseAnthropicToolCalls(blocks)).toEqual([
      { id: 'toolu_123', name: 'weather', arguments: { city: 'Denver' } },
    ]);
  });

  it('converts neutral citation data to the SDK citation shape', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'The cited answer.',
              citations: [
                {
                  type: 'char_location',
                  cited_text: 'The cited answer.',
                  document_index: 0,
                  document_title: 'Reference',
                  start_char_index: 0,
                  end_char_index: 18,
                },
              ],
            },
          ],
        },
      ],
    });

    const { messages } = toAnthropicMessagesForSdk(conversation);

    expect(messages[0]?.content).toEqual([
      {
        type: 'text',
        text: 'The cited answer.',
        citations: [
          {
            type: 'char_location',
            cited_text: 'The cited answer.',
            document_index: 0,
            document_title: 'Reference',
            start_char_index: 0,
            end_char_index: 18,
          },
        ],
      },
    ]);
  });
});
