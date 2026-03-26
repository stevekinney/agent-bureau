import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { withEmbeddingCache } from '../src/embedding-cache';
import { getMemoryStatus } from '../src/status';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

describe('getMemoryStatus', () => {
  let memory: Memory;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    const embedder = createMockEmbedder(DIMENSION);
    memory = createMemory({ embedder, storage, dimension: DIMENSION });
    await memory.init();
  });

  it('returns correct total entry count', async () => {
    await memory.remember('first');
    await memory.remember('second');
    await memory.remember('third');

    const status = await getMemoryStatus(storage);

    expect(status.totalEntries).toBe(3);
  });

  it('returns namespace breakdown', async () => {
    await memory.remember('entry a', { namespace: 'alpha' });
    await memory.remember('entry b', { namespace: 'alpha' });
    await memory.remember('entry c', { namespace: 'beta' });

    const status = await getMemoryStatus(storage);

    expect(status.namespaces).toHaveLength(2);
    const alpha = status.namespaces.find((n) => n.name === 'alpha');
    const beta = status.namespaces.find((n) => n.name === 'beta');
    expect(alpha?.count).toBe(2);
    expect(beta?.count).toBe(1);
  });

  it('sorts namespaces by count descending', async () => {
    await memory.remember('a', { namespace: 'small' });
    await memory.remember('b', { namespace: 'large' });
    await memory.remember('c', { namespace: 'large' });
    await memory.remember('d', { namespace: 'large' });

    const status = await getMemoryStatus(storage);

    expect(status.namespaces[0]!.name).toBe('large');
    expect(status.namespaces[1]!.name).toBe('small');
  });

  it('reports storage type from constructor name', async () => {
    const status = await getMemoryStatus(storage);
    // Constructor name may be minified, but should always be a string.
    expect(typeof status.storageType).toBe('string');
    expect(status.storageType.length).toBeGreaterThan(0);
  });

  it('reports custom storage type when provided', async () => {
    const status = await getMemoryStatus(storage, { storageType: 'SQLite' });
    expect(status.storageType).toBe('SQLite');
  });

  it('reports embedding cache size when a CachedEmbedder is provided', async () => {
    const inner = createMockEmbedder(DIMENSION);
    const cachedEmbedder = withEmbeddingCache(inner);

    // Prime the cache.
    await cachedEmbedder(['hello', 'world']);

    const status = await getMemoryStatus(storage, { embedder: cachedEmbedder });

    expect(status.embeddingCacheSize).toBe(2);
  });

  it('does not report cache size for a non-cached embedder', async () => {
    const embedder = createMockEmbedder(DIMENSION);

    const status = await getMemoryStatus(storage, { embedder });

    expect(status.embeddingCacheSize).toBeUndefined();
  });

  it('returns zero entries for an empty memory', async () => {
    const status = await getMemoryStatus(storage);

    expect(status.totalEntries).toBe(0);
    expect(status.namespaces).toHaveLength(0);
  });
});
