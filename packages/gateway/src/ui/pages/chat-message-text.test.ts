import { describe, expect, it } from 'bun:test';

import { extractChatMessageText } from './chat-message-text';

describe('extractChatMessageText', () => {
  it('returns a plain string message unchanged', () => {
    expect(extractChatMessageText('Hello there')).toBe('Hello there');
  });

  it('joins the text parts of a multi-modal message, dropping non-text parts', () => {
    const content = [
      { type: 'text' as const, text: 'First line' },
      { type: 'image' as const, url: 'https://example.test/image.png' },
      { type: 'text' as const, text: 'Second line' },
    ];

    expect(extractChatMessageText(content)).toBe('First line\nSecond line');
  });

  it('returns an empty string for a multi-modal message with no text parts', () => {
    const content = [{ type: 'image' as const, url: 'https://example.test/image.png' }];

    expect(extractChatMessageText(content)).toBe('');
  });
});
