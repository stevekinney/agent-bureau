import { describe, expect, it } from 'bun:test';

import { createMockEmbedder } from '../src/test/index';

describe('createMockEmbedder', () => {
  it('produces vectors of the specified dimension', () => {
    const embedder = createMockEmbedder(64);
    const [vector] = embedder(['hello']);
    expect(vector).toHaveLength(64);
  });

  it('defaults to 128 dimensions', () => {
    const embedder = createMockEmbedder();
    const [vector] = embedder(['hello']);
    expect(vector).toHaveLength(128);
  });

  it('produces the same vector for the same text (deterministic)', () => {
    const embedder = createMockEmbedder(32);
    const [first] = embedder(['hello world']);
    const [second] = embedder(['hello world']);
    expect(first).toEqual(second);
  });

  it('produces different vectors for different text', () => {
    const embedder = createMockEmbedder(32);
    const [vectorA] = embedder(['hello']);
    const [vectorB] = embedder(['goodbye']);
    expect(vectorA).not.toEqual(vectorB);
  });

  it('produces unit vectors (magnitude close to 1)', () => {
    const embedder = createMockEmbedder(64);
    const [vector] = embedder(['some test text']);
    const magnitude = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('handles multiple texts in a single call', () => {
    const embedder = createMockEmbedder(16);
    const vectors = embedder(['one', 'two', 'three']);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toHaveLength(16);
    expect(vectors[1]).toHaveLength(16);
    expect(vectors[2]).toHaveLength(16);
  });
});
