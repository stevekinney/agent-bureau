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
    const input: readonly { type: 'text'; text: string }[] = [
      { type: 'text', text: 'Test' },
    ];
    const result = copyContent(input);

    expect(result).toEqual([{ type: 'text', text: 'Test' }]);
  });
});
