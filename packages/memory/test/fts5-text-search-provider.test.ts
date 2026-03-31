import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createFts5TextSearchProvider, isFts5Available } from '../src/fts5-text-search-provider';
import type { TextSearchProvider } from '../src/text-search-provider';

const runtimeOverrideSymbol = Symbol.for('agent-bureau.memory.fts5.runtime');

describe('isFts5Available', () => {
  it('returns true in the Bun runtime', () => {
    expect(isFts5Available()).toBe(true);
  });

  it('returns false when the hidden runtime override disables Bun', () => {
    (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol] = { Bun: undefined };

    try {
      expect(isFts5Available()).toBe(false);
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol];
    }
  });
});

describe('createFts5TextSearchProvider', () => {
  let provider: TextSearchProvider;

  beforeEach(async () => {
    provider = createFts5TextSearchProvider({ filename: ':memory:' });
    await provider.init();
  });

  afterEach(async () => {
    await provider.close();
  });

  it('indexes and searches for matching content', async () => {
    await provider.index('1', 'database connection pooling', 'default');
    await provider.index('2', 'authentication middleware setup', 'default');
    await provider.index('3', 'database migration scripts', 'default');

    const results = await provider.search('database', 'default');

    expect(results.size).toBe(2);
    expect(results.has('1')).toBe(true);
    expect(results.has('3')).toBe(true);
    expect(results.has('2')).toBe(false);
  });

  it('returns scores > 0 for matching content', async () => {
    await provider.index('1', 'database connection pooling', 'default');

    const results = await provider.search('database', 'default');

    expect(results.get('1')).toBeGreaterThan(0);
  });

  it('returns empty results for non-matching queries', async () => {
    await provider.index('1', 'database connection pooling', 'default');

    const results = await provider.search('authentication', 'default');

    expect(results.size).toBe(0);
  });

  it('scopes search results by namespace', async () => {
    await provider.index('1', 'database pooling', 'ns-a');
    await provider.index('2', 'database migration', 'ns-b');

    const resultsA = await provider.search('database', 'ns-a');
    const resultsB = await provider.search('database', 'ns-b');

    expect(resultsA.size).toBe(1);
    expect(resultsA.has('1')).toBe(true);

    expect(resultsB.size).toBe(1);
    expect(resultsB.has('2')).toBe(true);
  });

  it('removes an entry so it no longer appears in search', async () => {
    await provider.index('1', 'database pooling', 'default');
    await provider.index('2', 'database migration', 'default');

    await provider.remove('1');

    const results = await provider.search('database', 'default');
    expect(results.size).toBe(1);
    expect(results.has('2')).toBe(true);
  });

  it('clears all entries in a namespace', async () => {
    await provider.index('1', 'database pooling', 'ns-a');
    await provider.index('2', 'database migration', 'ns-a');
    await provider.index('3', 'database sharding', 'ns-b');

    await provider.clear('ns-a');

    const resultsA = await provider.search('database', 'ns-a');
    const resultsB = await provider.search('database', 'ns-b');

    expect(resultsA.size).toBe(0);
    expect(resultsB.size).toBe(1);
  });

  it('clears all entries when no namespace is specified', async () => {
    await provider.index('1', 'database pooling', 'ns-a');
    await provider.index('2', 'database migration', 'ns-b');

    await provider.clear();

    const resultsA = await provider.search('database', 'ns-a');
    const resultsB = await provider.search('database', 'ns-b');
    expect(resultsA.size).toBe(0);
    expect(resultsB.size).toBe(0);
  });

  it('updates indexed content when index is called again with the same id', async () => {
    await provider.index('1', 'old content about cats', 'default');
    await provider.index('1', 'new content about database pooling', 'default');

    const catResults = await provider.search('cats', 'default');
    const dbResults = await provider.search('database', 'default');

    expect(catResults.size).toBe(0);
    expect(dbResults.size).toBe(1);
  });

  it('returns empty map for empty query', async () => {
    await provider.index('1', 'database pooling', 'default');

    const results = await provider.search('', 'default');
    expect(results.size).toBe(0);
  });

  it('handles queries containing double quotes without error', async () => {
    await provider.index('1', 'database connection pooling', 'default');

    // A query like `is "the"` where all tokens are stop words triggers the
    // fallback path. Previously, the embedded double quotes produced malformed
    // FTS5 MATCH syntax (e.g. `""the""`).
    const results = await provider.search('is "the"', 'default');

    // Should not throw — returns either matches or an empty map.
    expect(results).toBeInstanceOf(Map);
  });

  it('returns results for fallback query terms after stripping quotes', async () => {
    await provider.index('1', 'database connection pooling', 'default');
    await provider.index('2', 'authentication middleware', 'default');

    // The word "database" is inside quotes in the raw query. After stripping
    // quotes and falling back to term matching, it should still match.
    const results = await provider.search('"database"', 'default');

    expect(results.size).toBeGreaterThanOrEqual(1);
    expect(results.has('1')).toBe(true);
  });

  it('returns empty map for a query that is only double quotes', async () => {
    await provider.index('1', 'database connection pooling', 'default');

    const results = await provider.search('"""', 'default');

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(0);
  });

  it('is idempotent on init', async () => {
    // Calling init again should not throw or corrupt state.
    await provider.init();

    await provider.index('1', 'test content', 'default');
    const results = await provider.search('test', 'default');
    expect(results.size).toBe(1);
  });

  it('rejects invalid SQLite table identifiers', () => {
    expect(() =>
      createFts5TextSearchProvider({
        filename: ':memory:',
        tableName: 'memory-fts;drop_table',
      }),
    ).toThrow('Invalid SQLite identifier');
  });

  it('throws a clear error when FTS5 is initialized outside Bun', async () => {
    (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol] = { Bun: undefined };
    const nonBunProvider = createFts5TextSearchProvider({ filename: ':memory:' });

    try {
      await expect(nonBunProvider.init()).rejects.toThrow(
        'FTS5 text search requires the Bun runtime',
      );
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol];
    }
  });

  it('returns an empty map when the FTS5 query execution throws', async () => {
    (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol] = {
      Bun,
      createDatabase: () => ({
        exec() {},
        run() {
          return { changes: 1 };
        },
        query() {
          return {
            all() {
              throw new Error('malformed MATCH query');
            },
          };
        },
        close() {},
      }),
    };
    const failingProvider = createFts5TextSearchProvider({ filename: ':memory:' });

    try {
      await failingProvider.init();
      const results = await failingProvider.search('database', 'default');
      expect(results).toEqual(new Map());
    } finally {
      await failingProvider.close();
      delete (globalThis as Record<PropertyKey, unknown>)[runtimeOverrideSymbol];
    }
  });
});
