import { describe, expect, it } from 'bun:test';

import { withEmbeddingCache } from '../src/embedding-cache';
import { createMockEmbedder } from '../src/test/index';

const DIMENSION = 64;

describe('embedding cache with namespaces', () => {
  it('produces different cache keys for the same text in different namespaces', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);

    const cacheA = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-a' });
    const cacheB = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-b' });

    await cacheA(['hello world']);
    await cacheB(['hello world']);

    // Both should have 1 entry each (no sharing)
    expect(cacheA.cache.size).toBe(1);
    expect(cacheB.cache.size).toBe(1);

    // The keys should be different
    const keyA = [...cacheA.cache.keys()][0]!;
    const keyB = [...cacheB.cache.keys()][0]!;
    expect(keyA).not.toBe(keyB);
  });

  it('cache hits do not cross namespace boundaries', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);
    let callCount = 0;
    const spyEmbedder = async (texts: string[]) => {
      callCount++;
      return baseEmbedder(texts);
    };

    const cacheA = withEmbeddingCache(spyEmbedder, { namespace: 'tenant-a' });
    const cacheB = withEmbeddingCache(spyEmbedder, { namespace: 'tenant-b' });

    // First call — cache miss for both
    callCount = 0;
    await cacheA(['same text']);
    expect(callCount).toBe(1);

    callCount = 0;
    await cacheB(['same text']);
    expect(callCount).toBe(1); // Should NOT be a cache hit from cacheA

    // Second call — cache hit for A
    callCount = 0;
    await cacheA(['same text']);
    expect(callCount).toBe(0); // Should be a cache hit
  });

  it('clearNamespace evicts only that namespace entries', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);
    const cache = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-a' });

    await cache(['text 1']);
    await cache(['text 2']);
    await cache(['text 3']);
    expect(cache.cache.size).toBe(3);

    cache.clearNamespace('tenant-a');
    expect(cache.cache.size).toBe(0);
  });

  it('clearNamespace does not affect other namespaces in same cache instance', async () => {
    // This test uses a single cache without namespace to show clearNamespace
    // only removes tracked entries. Use two separate caches to demonstrate isolation.
    const baseEmbedder = createMockEmbedder(DIMENSION);
    const cache = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-a' });

    await cache(['text 1']);
    expect(cache.cache.size).toBe(1);

    // Clear a different namespace — should not affect tenant-a's entries
    cache.clearNamespace('tenant-b');
    expect(cache.cache.size).toBe(1);
  });

  it('clearNamespace is a no-op when namespace has no entries', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);
    const cache = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-a' });

    // Should not throw
    cache.clearNamespace('nonexistent');
    expect(cache.cache.size).toBe(0);
  });

  it('works without namespace (backward compatible)', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);
    let callCount = 0;
    const spyEmbedder = async (texts: string[]) => {
      callCount++;
      return baseEmbedder(texts);
    };

    const cache = withEmbeddingCache(spyEmbedder);

    callCount = 0;
    await cache(['test']);
    expect(callCount).toBe(1);

    callCount = 0;
    await cache(['test']);
    expect(callCount).toBe(0); // Cache hit
  });

  it('clearCache removes all entries regardless of namespace', async () => {
    const baseEmbedder = createMockEmbedder(DIMENSION);
    const cache = withEmbeddingCache(baseEmbedder, { namespace: 'tenant-a' });

    await cache(['text 1', 'text 2']);
    expect(cache.cache.size).toBe(2);

    cache.clearCache();
    expect(cache.cache.size).toBe(0);
  });

  it('cleans up namespace indexes when eviction removes the last key', async () => {
    let callCount = 0;
    const baseEmbedder = async (texts: string[]) => {
      callCount++;
      return createMockEmbedder(DIMENSION)(texts);
    };
    const cache = withEmbeddingCache(baseEmbedder, {
      namespace: 'tenant-a',
      maximumEntries: 0,
    });

    await cache(['text 1']);
    expect(cache.cache.size).toBe(0);

    await cache.clearNamespace('tenant-a');
    await cache(['text 1']);

    expect(callCount).toBe(2);
  });
});
