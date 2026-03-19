import { describe, expect, it } from 'bun:test';

import {
  containsBase64Data,
  createTruncatingAsyncIterable,
  DEFAULT_ERROR_MAX_CHARACTERS,
  DEFAULT_MAX_CHARACTERS,
  isHighSurrogate,
  isLowSurrogate,
  safeSlice,
  stripBase64Data,
  truncateText,
  truncateToolResultContent,
} from '../src/truncation/index';

describe('truncation', () => {
  describe('isHighSurrogate / isLowSurrogate', () => {
    it('identifies high surrogates', () => {
      expect(isHighSurrogate(0xd800)).toBe(true);
      expect(isHighSurrogate(0xdbff)).toBe(true);
      expect(isHighSurrogate(0xdc00)).toBe(false);
      expect(isHighSurrogate(0x0041)).toBe(false);
    });
    it('identifies low surrogates', () => {
      expect(isLowSurrogate(0xdc00)).toBe(true);
      expect(isLowSurrogate(0xdfff)).toBe(true);
      expect(isLowSurrogate(0xd800)).toBe(false);
    });
  });

  describe('safeSlice', () => {
    it('returns input unchanged when under limit', () => {
      expect(safeSlice('hello', 10)).toBe('hello');
    });
    it('returns empty string for maxLength 0', () => {
      expect(safeSlice('hello', 0)).toBe('');
    });
    it('returns empty string for negative maxLength', () => {
      expect(safeSlice('test', -1)).toBe('');
    });
    it('does not break emoji surrogate pairs', () => {
      const emoji = '\uD83D\uDE00'; // 😀 — 2 code units
      expect(safeSlice(emoji, 1)).toBe(''); // Can't include half a pair
    });
    it('keeps emoji when limit accommodates full pair', () => {
      expect(safeSlice('\uD83D\uDE00', 2)).toBe('\uD83D\uDE00');
    });
    it('handles string of only surrogate pairs', () => {
      const text = '\uD83D\uDE00\uD83D\uDE01\uD83D\uDE02'; // 😀😁😂 — 6 code units
      expect(safeSlice(text, 4)).toBe('\uD83D\uDE00\uD83D\uDE01');
      expect(safeSlice(text, 3)).toBe('\uD83D\uDE00'); // can't split 😁
    });
    it('handles string exactly at limit', () => {
      expect(safeSlice('abc', 3)).toBe('abc');
    });
    it('handles empty string', () => {
      expect(safeSlice('', 5)).toBe('');
    });
    it('excludes orphaned high surrogate at slice boundary', () => {
      // '\uD800' is a high surrogate without a matching low surrogate partner
      const text = 'a\uD800b';
      expect(safeSlice(text, 2)).toBe('a');
    });
  });

  describe('truncateText', () => {
    it('does not modify text under limit', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });
    it('does not modify text exactly at limit', () => {
      expect(truncateText('hello', 5)).toBe('hello');
    });
    it('appends marker on truncation', () => {
      const result = truncateText('a'.repeat(100), 50);
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result).toContain('\u2026(truncated)\u2026');
    });
    it('uses custom marker', () => {
      const result = truncateText('a'.repeat(20), 15, { marker: '...' });
      expect(result).toEndWith('...');
      expect(result.length).toBeLessThanOrEqual(15);
    });
    it('handles very small maxCharacters', () => {
      const result = truncateText('a'.repeat(100), 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });
    it('handles empty string', () => {
      expect(truncateText('', 10)).toBe('');
    });
  });

  describe('containsBase64Data', () => {
    it('detects data:image/png;base64, pattern', () => {
      expect(containsBase64Data('data:image/png;base64,abc123')).toBe(true);
    });
    it('detects other MIME types', () => {
      expect(containsBase64Data('data:application/pdf;base64,xyz')).toBe(true);
    });
    it('returns false for normal text', () => {
      expect(containsBase64Data('just some text')).toBe(false);
    });
    it('returns false for empty string', () => {
      expect(containsBase64Data('')).toBe(false);
    });
  });

  describe('stripBase64Data', () => {
    it('replaces base64 data with default placeholder', () => {
      const input = 'before data:image/png;base64,abc123def456 after';
      const result = stripBase64Data(input);
      expect(result).toContain('[base64 data omitted]');
      expect(result).not.toContain('abc123def456');
    });
    it('uses custom placeholder', () => {
      const input = 'data:image/png;base64,abc123';
      expect(stripBase64Data(input, '[REMOVED]')).toContain('[REMOVED]');
    });
    it('handles multiple base64 blocks', () => {
      const input = 'data:image/png;base64,aaa data:image/jpeg;base64,bbb';
      const result = stripBase64Data(input);
      const matches = result.match(/\[base64 data omitted\]/g);
      expect(matches?.length).toBe(2);
    });
    it('returns unchanged text with no base64', () => {
      expect(stripBase64Data('normal text')).toBe('normal text');
    });
  });

  describe('truncateToolResultContent', () => {
    it('strips base64 then truncates', () => {
      const base64Block = 'data:image/png;base64,' + 'A'.repeat(10000);
      const result = truncateToolResultContent(base64Block);
      expect(result).not.toContain('AAAA');
      expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARACTERS);
    });
    it('uses error threshold when isError is true', () => {
      const longText = 'E'.repeat(1000);
      const result = truncateToolResultContent(longText, { isError: true });
      expect(result.length).toBeLessThanOrEqual(DEFAULT_ERROR_MAX_CHARACTERS);
    });
    it('passes through short content unchanged', () => {
      expect(truncateToolResultContent('short')).toBe('short');
    });
    it('handles empty string', () => {
      expect(truncateToolResultContent('')).toBe('');
    });
    it('uses custom maxCharacters', () => {
      const result = truncateToolResultContent('a'.repeat(200), {
        maxCharacters: 50,
      });
      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  describe('constants', () => {
    it('has expected default values', () => {
      expect(DEFAULT_MAX_CHARACTERS).toBe(8000);
      expect(DEFAULT_ERROR_MAX_CHARACTERS).toBe(400);
    });
  });

  describe('streaming truncation', () => {
    async function* fromChunks<T>(chunks: T[]): AsyncIterable<T> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
      const results: T[] = [];
      for await (const item of iterable) {
        results.push(item);
      }
      return results;
    }

    it('stops iteration when accumulated length exceeds maxCharacters', async () => {
      const chunks = ['aaaa', 'bbbb', 'cccc', 'dddd']; // 16 chars total
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 10,
      });

      const collected = await collectAll(wrapped);
      const joined = collected.join('');

      expect(joined).toContain('\u2026(truncated)\u2026');
      // First two chunks (8 chars) fit, third chunk (4 chars) would push to 12 > 10
      // so only 2 remaining chars from third chunk + marker
      expect(collected[0]).toBe('aaaa');
      expect(collected[1]).toBe('bbbb');
      // Third chunk gets sliced to 2 chars remaining
      expect(collected[2]).toBe('cc');
      expect(collected[3]).toBe('\n\u2026(truncated)\u2026');
      expect(collected).toHaveLength(4);
    });

    it('passes through short streams unchanged', async () => {
      const chunks = ['hello', ' ', 'world'];
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 100,
      });

      const collected = await collectAll(wrapped);
      expect(collected).toEqual(['hello', ' ', 'world']);
    });

    it('handles non-string chunks with length accounting via stringify', async () => {
      const chunks = [{ a: 1 }, { b: 2 }, { c: 3 }];
      // JSON.stringify({a:1}) = '{"a":1}' = 7 chars each
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 15,
      });

      const collected = await collectAll(wrapped);
      // First two chunks: 7 + 7 = 14 chars, fits under 15
      // Third chunk: 14 + 7 = 21 > 15, so marker emitted
      expect(collected[0]).toEqual({ a: 1 });
      expect(collected[1]).toEqual({ b: 2 });
      expect(collected[2]).toBe('\n\u2026(truncated)\u2026');
      expect(collected).toHaveLength(3);
    });

    it('handles empty stream', async () => {
      const wrapped = createTruncatingAsyncIterable(fromChunks([]), {
        maxCharacters: 100,
      });

      const collected = await collectAll(wrapped);
      expect(collected).toEqual([]);
    });

    it('handles chunk exactly at limit without marker', async () => {
      const chunks = ['aaaaa', 'bbbbb']; // 5 + 5 = 10 chars
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 10,
      });

      const collected = await collectAll(wrapped);
      expect(collected).toEqual(['aaaaa', 'bbbbb']);
    });

    it('uses safeSlice to avoid splitting surrogate pairs on the cut boundary', async () => {
      const emoji = '\uD83D\uDE00'; // 😀 — 2 code units
      const chunks = ['aaa', emoji + 'bbb']; // 3 + 5 = 8 code units total
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 4, // room for 1 more char after 'aaa'
      });

      const collected = await collectAll(wrapped);
      // After 'aaa' (3 chars), remaining is 1 char. The next chunk starts with
      // a surrogate pair (2 code units). safeSlice('😀bbb', 1) cannot include
      // half a surrogate pair, so it returns ''.
      expect(collected[0]).toBe('aaa');
      expect(collected[1]).toBe('');
      expect(collected[2]).toBe('\n\u2026(truncated)\u2026');
    });

    it('uses default maxCharacters when none specified', async () => {
      // DEFAULT_MAX_CHARACTERS is 8000
      const chunks = ['a'.repeat(4000), 'b'.repeat(4000)]; // exactly 8000
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks));

      const collected = await collectAll(wrapped);
      expect(collected).toEqual(['a'.repeat(4000), 'b'.repeat(4000)]);
    });

    it('uses custom marker', async () => {
      const chunks = ['aaaa', 'bbbb', 'cccc'];
      const wrapped = createTruncatingAsyncIterable(fromChunks(chunks), {
        maxCharacters: 10,
        marker: '...',
      });

      const collected = await collectAll(wrapped);
      expect(collected).toContain('...');
    });
  });
});
