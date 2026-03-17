import { describe, expect, test } from 'bun:test';

import { appendUserMessage, createConversation } from '../src/conversation/index';
import { exportMarkdown, normalizeLineEndings } from '../src/export';

describe('export helpers', () => {
  test('exportMarkdown normalizes line endings', () => {
    let conversation = createConversation({ id: 'conv-1' });
    conversation = appendUserMessage(conversation, 'Line 1\r\nLine 2');

    const markdown = exportMarkdown(conversation);

    expect(markdown).toContain('Line 1\nLine 2');
    expect(markdown).not.toContain('\r\n');
  });

  test('normalizeLineEndings converts CRLF and CR to LF', () => {
    expect(normalizeLineEndings('a\r\nb')).toBe('a\nb');
    expect(normalizeLineEndings('a\rb')).toBe('a\nb');
  });
});
