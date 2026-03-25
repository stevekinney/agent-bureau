import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createSQLiteMemory } from '../src/create-sqlite-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

describe('createMemory with FTS5 integration', () => {
  let memory: Memory;

  beforeEach(async () => {
    const embedder = createMockEmbedder(DIMENSION);
    memory = createSQLiteMemory({
      embedder,
      filename: ':memory:',
      dimension: DIMENSION,
    });
    await memory.init();
  });

  afterEach(async () => {
    await memory.close();
  });

  it('remembers and recalls entries using FTS5', async () => {
    await memory.remember('database connection pooling strategies');
    await memory.remember('authentication middleware configuration');
    await memory.remember('database migration best practices');

    const results = await memory.recall('database', { limit: 10 });

    // FTS5 should boost results containing "database".
    expect(results.length).toBeGreaterThan(0);

    const contents = results.map((r) => r.content);
    // At least one result should contain "database".
    expect(contents.some((c) => c.includes('database'))).toBe(true);
  });

  it('forget removes entries from FTS5 index', async () => {
    const entry = await memory.remember('unique searchable content for FTS5 test');

    let results = await memory.recall('unique searchable content');
    expect(results.length).toBeGreaterThan(0);

    await memory.forget(entry.id);

    results = await memory.recall('unique searchable content');
    expect(results).toHaveLength(0);
  });

  it('forgetAll clears the FTS5 index for the namespace', async () => {
    await memory.remember('first entry');
    await memory.remember('second entry');

    await memory.forgetAll();

    const results = await memory.recall('entry');
    expect(results).toHaveLength(0);
  });

  it('works with embedding cache enabled alongside FTS5', async () => {
    const embedder = createMockEmbedder(DIMENSION);
    const cachedMemory = createSQLiteMemory({
      embedder,
      filename: ':memory:',
      dimension: DIMENSION,
      embeddingCache: true,
    });

    await cachedMemory.init();

    await cachedMemory.remember('cached and indexed content');
    const results = await cachedMemory.recall('cached indexed content');
    expect(results.length).toBeGreaterThan(0);

    await cachedMemory.close();
  });

  it('can disable FTS5 with disableFts5 option', async () => {
    const embedder = createMockEmbedder(DIMENSION);
    const noFtsMemory = createSQLiteMemory({
      embedder,
      filename: ':memory:',
      dimension: DIMENSION,
      disableFts5: true,
    });

    await noFtsMemory.init();

    // Should still work with in-memory BM25 fallback.
    await noFtsMemory.remember('fallback BM25 content');
    const results = await noFtsMemory.recall('fallback BM25 content');
    expect(results.length).toBeGreaterThan(0);

    await noFtsMemory.close();
  });
});
