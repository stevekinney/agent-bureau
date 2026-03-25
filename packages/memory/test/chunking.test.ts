import { describe, expect, it } from 'bun:test';

import { chunkMarkdown } from '../src/chunking';

describe('chunkMarkdown', () => {
  it('returns an empty array for empty content', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only content', () => {
    expect(chunkMarkdown('   \n  \n  ')).toEqual([]);
  });

  it('returns a single chunk for short content', () => {
    const chunks = chunkMarkdown('Hello world');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Hello world');
    expect(chunks[0]!.startLine).toBe(0);
    expect(chunks[0]!.endLine).toBe(0);
    expect(chunks[0]!.index).toBe(0);
  });

  it('splits content into multiple chunks when exceeding token limit', () => {
    // 400 tokens × 4 chars/token = 1600 chars per chunk.
    // Build content that forces multiple chunks.
    const line = 'A'.repeat(100); // 100 chars per line
    const lines = Array.from({ length: 30 }, () => line); // 3000 chars total
    const content = lines.join('\n');

    const chunks = chunkMarkdown(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  it('preserves correct line numbers across chunks', () => {
    const line = 'X'.repeat(100);
    const lines = Array.from({ length: 30 }, () => line);
    const content = lines.join('\n');

    const chunks = chunkMarkdown(content);

    // First chunk always starts at line 0.
    expect(chunks[0]!.startLine).toBe(0);

    // Each chunk's startLine should be <= its endLine.
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });

  it('includes overlap between adjacent chunks', () => {
    // Use small limits to produce many chunks.
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'content '.repeat(10)}`);
    const content = lines.join('\n');

    const chunks = chunkMarkdown(content, { maximumTokens: 50, overlapTokens: 10 });

    if (chunks.length >= 2) {
      // The end of chunk N should overlap with the start of chunk N+1.
      const firstChunkLines = chunks[0]!.text.split('\n');
      const secondChunkLines = chunks[1]!.text.split('\n');

      // At least one line from the end of chunk 0 should appear at the start of chunk 1.
      const lastLinesOfFirst = firstChunkLines.slice(-3);
      const firstLinesOfSecond = secondChunkLines.slice(0, 3);

      const overlap = lastLinesOfFirst.filter((line) => firstLinesOfSecond.includes(line));
      expect(overlap.length).toBeGreaterThan(0);
    }
  });

  it('handles very long lines by splitting into segments', () => {
    // One line of 5000 chars exceeds the default 1600 char limit.
    const longLine = 'B'.repeat(5000);
    const chunks = chunkMarkdown(longLine);

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should reference line 0 since it's a single line.
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(0);
      expect(chunk.endLine).toBe(0);
    }
  });

  it('respects custom maximumTokens and overlapTokens', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
    const content = lines.join('\n');

    const defaultChunks = chunkMarkdown(content);
    const smallChunks = chunkMarkdown(content, { maximumTokens: 20, overlapTokens: 5 });

    expect(smallChunks.length).toBeGreaterThan(defaultChunks.length);
  });

  it('assigns sequential indices starting from 0', () => {
    const lines = Array.from({ length: 30 }, () => 'Y'.repeat(100));
    const content = lines.join('\n');

    const chunks = chunkMarkdown(content);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  it('does not infinite-loop when maximumTokens is zero', () => {
    const content = 'Hello world\nSecond line';
    const chunks = chunkMarkdown(content, { maximumTokens: 0 });

    // maximumTokens is clamped to 1, so chunking should still terminate and produce output.
    expect(chunks.length).toBeGreaterThan(0);
    const reassembled = chunks.map((c) => c.text).join('');
    expect(reassembled).toContain('Hello');
  });

  it('does not infinite-loop when maximumTokens is negative', () => {
    const content = 'Some content here';
    const chunks = chunkMarkdown(content, { maximumTokens: -5 });

    expect(chunks.length).toBeGreaterThan(0);
  });

  it('produces a single chunk when content fits within the limit', () => {
    const content = 'Short content\nwith a few lines\nthat fits easily.';
    const chunks = chunkMarkdown(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.startLine).toBe(0);
    expect(chunks[0]!.endLine).toBe(2);
  });
});
