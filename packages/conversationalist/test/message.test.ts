import { describe, expect, test } from 'bun:test';

import type { Message } from '../src/types';
import {
  createMessage,
  isAssistantMessage,
  messageHasImages,
  messageParts,
  messageText,
  messageToJSON,
  messageToString,
} from '../src/utilities';

function base(now = new Date().toISOString()): Message {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    position: 0,
    createdAt: now,
    metadata: {},
    hidden: false,
  };
}

describe('message helpers', () => {
  test('messageToJSON for string content', () => {
    const msg = createMessage(base());
    const json = messageToJSON(msg);
    expect(json.content).toBe('hello');
  });

  test('messageToJSON preserves assistant-only fields', () => {
    const msg = createMessage({
      id: 'assistant',
      role: 'assistant',
      content: 'Done',
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
      goalCompleted: true,
    });
    const json = messageToJSON(msg);
    expect(json.role).toBe('assistant');
    expect((json as any).goalCompleted).toBe(true);
  });

  test('parts/text/hasImages/toString with multimodal content', () => {
    const now = new Date().toISOString();
    const message: Message = {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', url: 'https://example.com/x.png', text: 'alt' },
      ],
      position: 1,
      createdAt: now,
      metadata: {},
      hidden: false,
    };
    const msg = createMessage(message);
    expect(messageParts(msg).length).toBe(2);
    expect(messageText(msg)).toContain('hi');
    expect(messageHasImages(msg)).toBeTrue();
    expect(messageToString(msg)).toContain('![');
  });

  test('messageToString omits structural blocks without leaving blank paragraphs', () => {
    // Regression: structural blocks (tool_use/thinking/etc.) must be dropped, not
    // rendered as '' and joined — otherwise [text, tool_use, text] would yield
    // 'A\n\n\n\nB' instead of 'A\n\nB'.
    const msg = createMessage({
      id: 'interleaved',
      role: 'assistant',
      content: [
        { type: 'text', text: 'A' },
        { type: 'thinking', thinking: 'private', signature: 'sig==' },
        { type: 'tool_use', id: 'c1', name: 't', input: { k: 1 } },
        { type: 'text', text: 'B' },
      ],
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
    });

    expect(messageToString(msg)).toBe('A\n\nB');
  });

  test('utilities module re-exports message helpers', async () => {
    const mod = await import('../src/utilities/message');
    expect(typeof mod.createMessage).toBe('function');
  });

  test('messageParts handles empty string content', () => {
    const msg = createMessage({
      id: 'empty',
      role: 'user',
      content: '',
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
    });

    expect(messageParts(msg)).toEqual([]);
    expect(messageToString(msg)).toBe('');
    expect(messageText(msg)).toBe('');
  });

  test('createMessage produces a deep copy immune to source mutation', () => {
    const toolCallArgs = { query: 'original' };
    const toolResultContent = { data: 'original' };
    const multiModalParts: Array<{ type: 'text'; text: string }> = [
      { type: 'text', text: 'original' },
    ];

    const original: Message = {
      id: 'deep-copy',
      role: 'tool-call',
      content: multiModalParts,
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
      toolCall: { id: 'tc-1', name: 'search', arguments: toolCallArgs },
      toolResult: { callId: 'tc-1', outcome: 'success', content: toolResultContent },
    };

    const copy = createMessage(original);

    // Mutate the originals
    toolCallArgs.query = 'mutated';
    toolResultContent.data = 'mutated';
    multiModalParts[0].text = 'mutated';

    // Copy should be unaffected
    const copyArgs = copy.toolCall!.arguments as Record<string, unknown>;
    expect(copyArgs.query).toBe('original');

    const copyResultContent = copy.toolResult!.content as Record<string, unknown>;
    expect(copyResultContent.data).toBe('original');

    const copyParts = copy.content as ReadonlyArray<{ type: string; text: string }>;
    expect(copyParts[0].text).toBe('original');
  });

  test('isAssistantMessage narrows assistant messages', () => {
    const msg = createMessage({
      id: 'assistant',
      role: 'assistant',
      content: 'Done',
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
    });

    expect(isAssistantMessage(msg)).toBe(true);
  });
});
