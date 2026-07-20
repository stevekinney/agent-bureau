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

  it('converts a web_search_tool_result block into an SDK request block without a cast', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        { role: 'user', content: 'Search for recent news about AI.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
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
              tool_use_id: 'srvtoolu_1',
              content: [
                {
                  type: 'web_search_result',
                  title: 'AI News',
                  url: 'https://example.com/ai-news',
                  encrypted_content: 'encrypted-payload',
                  page_age: '2 days ago',
                },
              ],
            },
          ],
        },
      ],
    });

    const { messages } = toAnthropicMessagesForSdk(conversation);

    const request: MessageCreateParamsNonStreaming = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages,
    };

    // Assignability without a cast: the SDK request param type accepts the
    // converted messages directly.
    expectTypeOf(request.messages).toExtend<MessageParam[]>();

    const searchResultMessage = messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'web_search_tool_result'),
    );
    expect(searchResultMessage?.content).toEqual([
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            title: 'AI News',
            url: 'https://example.com/ai-news',
            encrypted_content: 'encrypted-payload',
            page_age: '2 days ago',
          },
        ],
      },
    ]);
  });

  it('converts a web_search_tool_result error block into an SDK request block', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_2',
              content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
            },
          ],
        },
      ],
    });

    const { messages } = toAnthropicMessagesForSdk(conversation);

    expect(messages[0]?.content).toEqual([
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      },
    ]);
  });

  it('rejects server-tool result blocks that are response-only in the installed SDK', () => {
    // code_execution_tool_result, bash_code_execution_tool_result,
    // text_editor_code_execution_tool_result, web_fetch_tool_result, and
    // container_upload are not part of the stable @anthropic-ai/sdk request
    // ContentBlockParam union (they only exist under resources/beta) as of
    // the SDK version this repo consumes. They round-trip through the
    // neutral adapter but must fail fast when converted for the SDK request
    // boundary instead of silently producing an invalid request.
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'code_execution_tool_result',
              tool_use_id: 'srvtoolu_3',
              content: { type: 'code_execution_result', stdout: '', stderr: '', return_code: 0 },
            },
          ],
        },
      ],
    });

    let caught: unknown;
    try {
      toAnthropicMessagesForSdk(conversation);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
  });
});
