import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer/adapters/anthropic';
import { describe, expect, expectTypeOf, it } from 'bun:test';
import { toAnthropicMessagesForSdk } from 'conversationalist/adapters/anthropic';
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

    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Calling a tool.', citations: null },
      { type: 'tool_use', id: 'toolu_123', name: 'weather', input: { city: 'Denver' } },
    ];

    expect(parseAnthropicToolCalls(blocks)).toEqual([
      { id: 'toolu_123', name: 'weather', arguments: { city: 'Denver' } },
    ]);
  });
});
