import { describe, expect, it } from 'bun:test';

import { copyContent, copyMultiModalContent } from '../src/multi-modal';

describe('copyMultiModalContent', () => {
  describe('text content', () => {
    it('copies text content with text property', () => {
      const input = { type: 'text' as const, text: 'Hello world' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({ type: 'text', text: 'Hello world' });
      expect(result).not.toBe(input);
    });

    it('copies text content without text property', () => {
      const input = { type: 'text' as const };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({ type: 'text' });
    });
  });

  describe('image content', () => {
    it('copies image content with all properties', () => {
      const input = {
        type: 'image' as const,
        url: 'https://example.com/image.png',
        mimeType: 'image/png',
        text: 'Alt text',
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({
        type: 'image',
        url: 'https://example.com/image.png',
        mimeType: 'image/png',
        text: 'Alt text',
      });
      expect(result).not.toBe(input);
    });

    it('copies image content with only url', () => {
      const input = {
        type: 'image' as const,
        url: 'https://example.com/image.png',
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({
        type: 'image',
        url: 'https://example.com/image.png',
      });
    });

    it('copies image content without optional properties', () => {
      const input = { type: 'image' as const };
      const result = copyMultiModalContent(input);

      expect(result).toEqual({ type: 'image' });
    });
  });

  describe('tool blocks deep-copy JSON payloads', () => {
    it('copies thinking content', () => {
      const input = { type: 'thinking' as const, thinking: 'reasoning', signature: 'sig' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('copies redacted thinking content', () => {
      const input = { type: 'redacted_thinking' as const, data: 'encrypted' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('deep-copies server_tool_use input so mutating the copy does not affect the original', () => {
      const input = {
        type: 'server_tool_use' as const,
        id: 'c1',
        name: 't',
        input: { nested: { value: 1 }, list: [1, 2] },
      };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      // The nested payload must be an independent reference.
      expect((result as typeof input).input).not.toBe(input.input);
      (result as typeof input).input = { nested: { value: 999 }, list: [9] };
      expect(input.input).toEqual({ nested: { value: 1 }, list: [1, 2] });
    });

    it('deep-copies a second server_tool_use input', () => {
      const input = {
        type: 'server_tool_use' as const,
        id: 's1',
        name: 'web_search',
        input: { query: 'x', opts: { deep: true } },
      };
      const result = copyMultiModalContent(input);
      expect((result as typeof input).input).not.toBe(input.input);
    });

    it('deep-copies web_search_tool_result content', () => {
      const input = {
        type: 'web_search_tool_result' as const,
        tool_use_id: 's1',
        content: [{ url: 'https://example.com', nested: { a: 1 } }],
      };
      const result = copyMultiModalContent(input);
      expect((result as typeof input).content).not.toBe(input.content);
    });

    it('deep-copies server tool result content variants', () => {
      const variants = [
        'code_execution_tool_result',
        'bash_code_execution_tool_result',
        'text_editor_code_execution_tool_result',
        'web_fetch_tool_result',
      ] as const;

      for (const type of variants) {
        const input = {
          type,
          tool_use_id: `${type}-1`,
          content: { nested: { value: type } },
        };
        const result = copyMultiModalContent(input);
        expect(result).toEqual(input);
        expect((result as typeof input).content).not.toBe(input.content);
      }
    });

    it('copies container upload content', () => {
      const input = { type: 'container_upload' as const, file_id: 'file-1' };
      const result = copyMultiModalContent(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });
  });
});

describe('copyContent', () => {
  it('returns string content unchanged', () => {
    const result = copyContent('Hello world');
    expect(result).toBe('Hello world');
  });

  it('copies array of multi-modal content', () => {
    const input = [
      { type: 'text' as const, text: 'Hello' },
      { type: 'image' as const, url: 'https://example.com/img.png' },
    ];
    const result = copyContent(input);

    expect(result).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'image', url: 'https://example.com/img.png' },
    ]);
    expect(result).not.toBe(input);
    expect((result as any[])[0]).not.toBe(input[0]);
  });

  it('handles empty array', () => {
    const result = copyContent([]);
    expect(result).toEqual([]);
  });

  it('handles readonly array', () => {
    const input: readonly { type: 'text'; text: string }[] = [{ type: 'text', text: 'Test' }];
    const result = copyContent(input);

    expect(result).toEqual([{ type: 'text', text: 'Test' }]);
  });
});
