import { describe, expect, it } from 'bun:test';

import type { EmbeddingVector } from '../src/core/registry/embeddings';
import { internalToolboxTestUtilities } from '../src/create-toolbox';

const { createCachedEmbedder } = internalToolboxTestUtilities;

describe('createCachedEmbedder', () => {
  it('evicts oldest entry when maxCacheSize is exceeded', () => {
    let callCount = 0;
    const mockEmbedder = (texts: string[]): EmbeddingVector[] => {
      callCount++;
      return texts.map(() => [callCount]);
    };

    const cached = createCachedEmbedder(mockEmbedder, { maxCacheSize: 2 });

    // Cache entries for 3 different inputs
    const result1 = cached(['a']);
    const result2 = cached(['b']);
    const result3 = cached(['c']);

    expect(callCount).toBe(3);

    // 'a' should have been evicted when 'c' was added (oldest eviction)
    // Calling 'a' again should trigger a new call
    cached(['a']);
    expect(callCount).toBe(4);

    // 'c' should still be cached (it was second-newest when 'a' was re-added,
    // and 'b' was evicted to make room for 'a')
    cached(['c']);
    expect(callCount).toBe(4); // no new call
  });

  it('does not evict when under maxCacheSize', () => {
    let callCount = 0;
    const mockEmbedder = (texts: string[]): EmbeddingVector[] => {
      callCount++;
      return texts.map(() => [callCount]);
    };

    const cached = createCachedEmbedder(mockEmbedder, { maxCacheSize: 10 });

    cached(['a']);
    cached(['b']);
    cached(['c']);
    expect(callCount).toBe(3);

    // All should be cached
    cached(['a']);
    cached(['b']);
    cached(['c']);
    expect(callCount).toBe(3);
  });
});
