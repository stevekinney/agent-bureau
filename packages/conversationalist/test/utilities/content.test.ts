import { describe, expect, test } from 'bun:test';

import { normalizeContent, toMultiModalArray } from '../../src/utilities/content';

describe('content utilities', () => {
  describe('toMultiModalArray', () => {
    test('converts strings to text content array', () => {
      const arr = toMultiModalArray('hello');
      expect(arr).toEqual([{ type: 'text', text: 'hello' }]);
    });

    test('wraps single object in array', () => {
      const single = { type: 'image', url: 'https://example.com/x.png' } as const;
      expect(toMultiModalArray(single)).toEqual([single]);
    });

    test('returns array as-is', () => {
      const arr = [
        { type: 'text', text: 'hello' },
        { type: 'image', url: 'https://example.com/x.png' },
      ] as const;
      expect(toMultiModalArray([...arr])).toEqual([...arr]);
    });
  });

  describe('normalizeContent', () => {
    test('returns undefined for undefined input', () => {
      expect(normalizeContent()).toBeUndefined();
    });

    test('returns string as-is', () => {
      expect(normalizeContent('x')).toBe('x');
    });

    test('wraps single object in array', () => {
      const single = { type: 'text', text: 't' } as const;
      expect(normalizeContent(single)).toEqual([single]);
    });

    test('returns array as-is', () => {
      const arr = [{ type: 'text', text: 't' }] as const;
      expect(normalizeContent([...arr])).toEqual([...arr]);
    });
  });
});
