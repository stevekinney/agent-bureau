import { describe, expect, it } from 'bun:test';

import {
  type AnthropicContentBlock,
  type AnthropicConversation,
  fromAnthropicMessages,
  toAnthropicMessagesForSdk,
} from '../src/adapters/anthropic';
import { appendMessages, createConversationHistory } from '../src/conversation';

function conversationFromBlock(block: AnthropicContentBlock) {
  return fromAnthropicMessages({
    messages: [{ role: 'user', content: [block] }],
  });
}

describe('Anthropic SDK adapter', () => {
  it('converts plain system and message strings without casts', () => {
    const conversation = fromAnthropicMessages({
      system: 'Follow the system instructions.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(toAnthropicMessagesForSdk(conversation)).toEqual({
      system: 'Follow the system instructions.',
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('normalizes public Anthropic text document sources to SDK text blocks', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'inline.txt',
              source: { type: 'text', media_type: 'text/plain', data: 'Plain text document' },
            },
          ],
        },
      ],
    });

    expect(toAnthropicMessagesForSdk(conversation).messages).toEqual([
      { role: 'user', content: 'Plain text document' },
    ]);
  });

  it('converts every request-safe block and cache-marked system segment', () => {
    const conversation = fromAnthropicMessages({
      system: [
        { type: 'text', text: 'Stable system segment', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic system segment' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect these inputs.', citations: null },
            { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
            },
            {
              type: 'document',
              title: 'remote.pdf',
              source: { type: 'url', url: 'https://example.com/remote.pdf' },
            },
            {
              type: 'document',
              title: 'inline.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Reasoning', signature: 'signature' },
            { type: 'redacted_thinking', data: 'encrypted' },
            {
              type: 'server_tool_use',
              id: 'server-tool-1',
              name: 'web_search',
              input: { query: 'news' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'server-tool-1',
              content: [
                {
                  type: 'web_search_result',
                  encrypted_content: 'encrypted-result',
                  title: 'Result',
                  url: 'https://example.com/result',
                  page_age: null,
                },
              ],
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: { id: 1 } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false },
          ],
        },
      ],
    });

    const sdk = toAnthropicMessagesForSdk(conversation, { extendedCacheTtl: true });

    expect(sdk.system).toEqual([
      {
        type: 'text',
        text: 'Stable system segment',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'text', text: 'Dynamic system segment' },
    ]);
    expect(JSON.stringify(sdk.messages)).toContain('web_search_tool_result');
    expect(JSON.stringify(sdk.messages)).toContain('tool_result');
    expect(JSON.stringify(sdk.messages)).toContain('inline.pdf');
  });

  it('converts every supported citation location', () => {
    const citations = [
      {
        type: 'char_location',
        cited_text: 'Characters',
        document_index: 0,
        document_title: 'Reference',
        end_char_index: 10,
        start_char_index: 0,
      },
      {
        type: 'page_location',
        cited_text: 'Pages',
        document_index: 1,
        document_title: null,
        end_page_number: 2,
        start_page_number: 1,
      },
      {
        type: 'content_block_location',
        cited_text: 'Blocks',
        document_index: 2,
        document_title: 'Blocks reference',
        end_block_index: 2,
        start_block_index: 1,
      },
      {
        type: 'web_search_result_location',
        cited_text: 'Web result',
        encrypted_index: 'encrypted-index',
        title: null,
        url: 'https://example.com/web-result',
      },
      {
        type: 'search_result_location',
        cited_text: 'Search result',
        end_block_index: 4,
        search_result_index: 3,
        source: 'source-id',
        start_block_index: 2,
        title: 'Search title',
      },
    ];
    const conversation = conversationFromBlock({ type: 'text', text: 'Cited', citations });

    const sdk = toAnthropicMessagesForSdk(conversation);

    expect(sdk.messages[0]?.content).toEqual([{ type: 'text', text: 'Cited', citations }]);
  });

  it('rejects malformed citation payloads at the SDK boundary', () => {
    const invalidCitations: unknown[] = [
      'not-an-array',
      [null],
      [{ type: 'unsupported' }],
      [
        {
          type: 'char_location',
          cited_text: 1,
          document_index: 0,
          document_title: null,
          end_char_index: 1,
          start_char_index: 0,
        },
      ],
      [
        {
          type: 'page_location',
          cited_text: 'Page',
          document_index: 'zero',
          document_title: null,
          end_page_number: 1,
          start_page_number: 1,
        },
      ],
      [
        {
          type: 'web_search_result_location',
          cited_text: 'Web',
          encrypted_index: 'index',
          title: 42,
          url: 'https://example.com',
        },
      ],
    ];

    for (const citations of invalidCitations) {
      const conversation = conversationFromBlock({
        type: 'text',
        text: 'Cited',
        citations,
      });
      expect(() => toAnthropicMessagesForSdk(conversation)).toThrow(TypeError);
    }
  });

  it('accepts every documented web-search error and page-age shape', () => {
    const errorCodes = [
      'invalid_tool_input',
      'unavailable',
      'max_uses_exceeded',
      'too_many_requests',
      'query_too_long',
    ] as const;

    for (const error_code of errorCodes) {
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: { type: 'web_search_tool_result_error', error_code },
      });
      expect(toAnthropicMessagesForSdk(conversation).messages).toHaveLength(1);
    }

    for (const page_age of [undefined, null, 'yesterday'] as const) {
      const result = {
        type: 'web_search_result',
        encrypted_content: 'encrypted',
        title: 'Result',
        url: 'https://example.com/result',
        ...(page_age === undefined ? {} : { page_age }),
      };
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: [result],
      });
      expect(toAnthropicMessagesForSdk(conversation).messages).toHaveLength(1);
    }
  });

  it('rejects malformed web-search result content', () => {
    const invalidContent = [
      null,
      { type: 'web_search_tool_result_error', error_code: 'unknown' },
      [{ type: 'web_search_result', encrypted_content: 'encrypted', title: 'Missing URL' }],
    ];

    for (const content of invalidContent) {
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content,
      });
      expect(() => toAnthropicMessagesForSdk(conversation)).toThrow(TypeError);
    }
  });

  it('rejects provider blocks the stable SDK cannot submit', () => {
    const unsupportedBlocks: AnthropicContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/svg+xml', data: 'c3Zn' },
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'text/plain', data: 'dGV4dA==' },
      },
      { type: 'document', source: { type: 'file', file_id: 'file-1' } },
      { type: 'server_tool_use', id: 'server-1', name: 'code_execution', input: {} },
      { type: 'code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'bash_code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'text_editor_code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'web_fetch_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'container_upload', file_id: 'file-1' },
    ];

    for (const block of unsupportedBlocks) {
      expect(() => toAnthropicMessagesForSdk(conversationFromBlock(block))).toThrow(TypeError);
    }
  });

  it('keeps only the final four message cache breakpoints', () => {
    let conversation = createConversationHistory();
    for (let index = 0; index < 5; index += 1) {
      conversation = appendMessages(conversation, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index}`,
        cacheBoundary: true,
      });
    }

    const sdk = toAnthropicMessagesForSdk(conversation);
    const cacheBreakpoints = sdk.messages.map((message) =>
      Array.isArray(message.content) ? message.content[0]?.cache_control : undefined,
    );

    expect(cacheBreakpoints).toEqual([
      undefined,
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
  });

  it('restores Anthropic file document references during neutral conversion', () => {
    const payload: AnthropicConversation = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', title: 'upload.pdf', source: { type: 'file', file_id: 'file-1' } },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);

    expect(conversation.messages[conversation.ids[0]!]?.content).toEqual([
      {
        type: 'document',
        name: 'upload.pdf',
        mimeType: 'application/octet-stream',
        source: { kind: 'reference', uri: 'file:file-1' },
      },
    ]);
  });
});
