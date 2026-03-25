import { describe, expect, it } from 'bun:test';

import { createSQLiteMemory } from '../src/create-sqlite-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Embedder, EmbeddingVector } from '../src/types';

const DIMENSION = 64;

function createSpyEmbedder(dimension = DIMENSION) {
  const inner = createMockEmbedder(dimension);
  const callCount = { value: 0 };

  const spy: Embedder & { callCount: { value: number } } = Object.assign(
    (texts: string[]): EmbeddingVector[] => {
      callCount.value++;
      return inner(texts);
    },
    { callCount },
  );

  return spy;
}

describe('createSQLiteMemory', () => {
  it('round-trips remember, recall, and forget with in-memory SQLite', async () => {
    const embedder = createMockEmbedder(DIMENSION);
    const memory = createSQLiteMemory({ embedder, filename: ':memory:', dimension: DIMENSION });

    await memory.init();

    const entry = await memory.remember('the sky is blue');
    expect(entry.id).toBeDefined();
    expect(entry.content).toBe('the sky is blue');

    const results = await memory.recall('sky blue');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toBe('the sky is blue');

    await memory.forget(entry.id);
    const afterForget = await memory.recall('sky blue');
    expect(afterForget).toHaveLength(0);

    await memory.close();
  });

  it('init and close work without error', async () => {
    const embedder = createMockEmbedder(DIMENSION);
    const memory = createSQLiteMemory({ embedder, filename: ':memory:' });

    await memory.init();
    await memory.close();
  });

  it('wraps the embedder with a cache when embeddingCache is true', async () => {
    const spy = createSpyEmbedder();
    const memory = createSQLiteMemory({
      embedder: spy,
      filename: ':memory:',
      dimension: DIMENSION,
      embeddingCache: true,
    });

    await memory.init();

    // remember calls embedder once.
    await memory.remember('cached content');
    const callsAfterRemember = spy.callCount.value;

    // recall with the exact same text should hit the cache.
    await memory.recall('cached content');
    expect(spy.callCount.value).toBe(callsAfterRemember);

    await memory.close();
  });

  it('wraps the embedder with a cache when embeddingCache is an options object', async () => {
    const spy = createSpyEmbedder();
    const memory = createSQLiteMemory({
      embedder: spy,
      filename: ':memory:',
      dimension: DIMENSION,
      embeddingCache: { maximumEntries: 100 },
    });

    await memory.init();

    await memory.remember('options cache');
    const callsAfterRemember = spy.callCount.value;

    await memory.recall('options cache');
    expect(spy.callCount.value).toBe(callsAfterRemember);

    await memory.close();
  });

  it('does not cache when embeddingCache is not set', async () => {
    const spy = createSpyEmbedder();
    const memory = createSQLiteMemory({
      embedder: spy,
      filename: ':memory:',
      dimension: DIMENSION,
    });

    await memory.init();

    await memory.remember('uncached content');
    const callsAfterRemember = spy.callCount.value;

    // recall embeds the query fresh — no cache.
    await memory.recall('uncached content');
    expect(spy.callCount.value).toBe(callsAfterRemember + 1);

    await memory.close();
  });

  it('supports count and forgetAll', async () => {
    const embedder = createMockEmbedder(DIMENSION);
    const memory = createSQLiteMemory({ embedder, filename: ':memory:', dimension: DIMENSION });

    await memory.init();

    await memory.remember('first');
    await memory.remember('second');
    expect(await memory.count()).toBe(2);

    await memory.forgetAll();
    expect(await memory.count()).toBe(0);

    await memory.close();
  });
});
