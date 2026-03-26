import { describe, expect, it } from 'bun:test';

import { withEmbeddingCache } from '../src/embedding-cache';
import { createMockEmbedder } from '../src/test/index';
import type { Embedder, EmbeddingVector } from '../src/types';

const DIMENSION = 64;

function createSpyEmbedder(dimension = DIMENSION) {
  const inner = createMockEmbedder(dimension);
  const calls: string[][] = [];

  const spy: Embedder & { calls: string[][] } = Object.assign(
    (texts: string[]): EmbeddingVector[] => {
      calls.push([...texts]);
      return inner(texts);
    },
    { calls },
  );

  return spy;
}

describe('withEmbeddingCache', () => {
  it('returns vectors in the correct order', async () => {
    const inner = createMockEmbedder(DIMENSION);
    const cached = withEmbeddingCache(inner);

    const results = await cached(['hello', 'world']);

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(DIMENSION);
    expect(results[1]).toHaveLength(DIMENSION);
  });

  it('caches results so the inner embedder is not called twice for the same text', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy);

    const first = await cached(['hello']);
    const second = await cached(['hello']);

    expect(spy.calls).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it('only calls the inner embedder for cache misses in a mixed batch', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy);

    // Prime cache with two entries.
    await cached(['alpha', 'beta']);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toEqual(['alpha', 'beta']);

    // Now request 5 texts: 2 cached + 3 new.
    const results = await cached(['alpha', 'gamma', 'beta', 'delta', 'epsilon']);

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1]).toEqual(['gamma', 'delta', 'epsilon']);
    expect(results).toHaveLength(5);
  });

  it('reassembles results in original order for mixed batches', async () => {
    const inner = createMockEmbedder(DIMENSION);
    const cached = withEmbeddingCache(inner);

    // Prime cache.
    const [alphaVector] = await cached(['alpha']);

    // Request with alpha in the middle.
    const results = await cached(['beta', 'alpha', 'gamma']);

    // The middle entry should match the cached alpha vector.
    expect(results[1]).toEqual(alphaVector);
  });

  it('evicts the oldest entry when maximumEntries is exceeded', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy, { maximumEntries: 2 });

    await cached(['first']);
    await cached(['second']);
    expect(cached.cache.size).toBe(2);

    // This should evict 'first'.
    await cached(['third']);
    expect(cached.cache.size).toBe(2);

    // 'first' is now evicted, so requesting it should call the embedder again.
    const callCountBefore = spy.calls.length;
    await cached(['first']);
    expect(spy.calls.length).toBe(callCountBefore + 1);
    expect(spy.calls[spy.calls.length - 1]).toEqual(['first']);
  });

  it('refreshes LRU order when a cached entry is accessed', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy, { maximumEntries: 2 });

    await cached(['first']);
    await cached(['second']);

    // Touch 'first' to make it recently used.
    await cached(['first']);

    // Insert 'third' — should evict 'second' (the least recently used), not 'first'.
    await cached(['third']);

    // 'first' should still be cached.
    const callCountBefore = spy.calls.length;
    await cached(['first']);
    expect(spy.calls.length).toBe(callCountBefore);

    // 'second' should have been evicted.
    await cached(['second']);
    expect(spy.calls.length).toBe(callCountBefore + 1);
  });

  it('clears all entries with clearCache()', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy);

    await cached(['hello', 'world']);
    expect(cached.cache.size).toBe(2);

    cached.clearCache();
    expect(cached.cache.size).toBe(0);

    // After clearing, the same texts should trigger a fresh embedder call.
    const callCountBefore = spy.calls.length;
    await cached(['hello']);
    expect(spy.calls.length).toBe(callCountBefore + 1);
  });

  it('returns an empty array for empty input', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy);

    const results = await cached([]);

    expect(results).toEqual([]);
    expect(spy.calls).toHaveLength(0);
  });

  it('produces deterministic hashes for the same text', async () => {
    const spy = createSpyEmbedder();
    const cached = withEmbeddingCache(spy);

    await cached(['deterministic']);
    await cached(['deterministic']);

    // Should only have called the inner embedder once.
    expect(spy.calls).toHaveLength(1);
    expect(cached.cache.size).toBe(1);
  });

  it('accepts a custom hash function', async () => {
    const spy = createSpyEmbedder();
    const hashCalls: string[] = [];
    const cached = withEmbeddingCache(spy, {
      hash: (text) => {
        hashCalls.push(text);
        return `custom-${text}`;
      },
    });

    await cached(['test']);

    expect(hashCalls).toEqual(['test']);
    expect(cached.cache.size).toBe(1);
  });
});
