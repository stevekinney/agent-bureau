import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { withNamespaceIsolation } from '../src/namespace-isolation';
import { getMemoryStatus } from '../src/status';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type {
  Memory,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
  OnConflictHandler,
} from '../src/types';

const DIMENSION = 64;

/**
 * Locks in the `createMemory` rewrite against the {@link MemoryRecordStorage}
 * contract using the in-memory backend. The broad per-feature suites (migrated
 * in a later phase) cover the rest; this file guards the behavioral seams that
 * the rewrite touched: dedup/conflict via `searchByVector`, the
 * hybrid-vs-vectorOnly threshold split, and scope-keyed `forget`.
 */
function createTestMemory(options?: {
  namespace?: string;
  deduplicationThreshold?: number;
  conflictThreshold?: number;
  onConflict?: OnConflictHandler;
}): Memory {
  return createMemory({
    embedder: createMockEmbedder(DIMENSION),
    storage: createInMemoryMemoryRecordStorage(),
    dimension: DIMENSION,
    ...options,
  });
}

describe('createMemory over MemoryRecordStorage', () => {
  let memory: Memory;

  beforeEach(async () => {
    memory = createTestMemory();
    await memory.init();
  });

  describe('remember and recall', () => {
    it('stores entries and recalls them by semantic query', async () => {
      await memory.remember('The weather is sunny today');
      await memory.remember('Machine learning is fascinating');

      expect(await memory.count()).toBe(2);
      const results = await memory.recall('sunny weather');
      expect(results.length).toBeGreaterThan(0);
    });

    it('exposes namespace on returned metadata from the record', async () => {
      const entry = await memory.remember('Scoped fact', { namespace: 'alpha' });
      expect(entry.metadata.namespace).toBe('alpha');

      const listed = await memory.list({ namespace: 'alpha' });
      expect(listed).toHaveLength(1);
      expect(listed[0]!.metadata.namespace).toBe('alpha');
    });
  });

  describe('deduplication', () => {
    it('merges identical content into one record', async () => {
      const first = await memory.remember('Exact same content');
      const second = await memory.remember('Exact same content');

      expect(first.id).toBe(second.id);
      expect(await memory.count()).toBe(1);
    });
  });

  describe('conflict resolution', () => {
    it('keeps both entries by default', async () => {
      const conflictMemory = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
      });
      await conflictMemory.init();

      const a = await conflictMemory.remember('Steve prefers TypeScript');
      const b = await conflictMemory.remember('Steve prefers Rust');

      expect(a.id).not.toBe(b.id);
      expect(await conflictMemory.count()).toBe(2);
    });

    it('replaces the existing entry when the handler returns replace', async () => {
      const conflictMemory = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict: () => 'replace',
      });
      await conflictMemory.init();

      const a = await conflictMemory.remember('Steve prefers TypeScript');
      const b = await conflictMemory.remember('Steve prefers Rust');

      expect(b.id).toBe(a.id);
      expect(b.content).toBe('Steve prefers Rust');
      expect(await conflictMemory.count()).toBe(1);
    });

    it('skips the new entry when the handler returns skip', async () => {
      const conflictMemory = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict: () => 'skip',
      });
      await conflictMemory.init();

      const a = await conflictMemory.remember('Steve prefers TypeScript');
      const b = await conflictMemory.remember('Steve prefers Rust');

      expect(b.id).toBe(a.id);
      expect(b.content).toBe('Steve prefers TypeScript');
      expect(await conflictMemory.count()).toBe(1);
    });

    it('surfaces the highest-similarity conflict to the handler', async () => {
      const calls: Array<{ similarity: number }> = [];
      const conflictMemory = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict: (_incoming, existing) => {
          calls.push({ similarity: existing.similarity });
          return 'keep-both';
        },
      });
      await conflictMemory.init();

      await conflictMemory.remember('Alpha numeric entry one');
      await conflictMemory.remember('Beta numeric entry two');
      calls.length = 0;
      await conflictMemory.remember('Gamma numeric entry three');

      expect(calls).toHaveLength(1);
      expect(calls[0]!.similarity).toBeTypeOf('number');
    });
  });

  describe('recall thresholds', () => {
    it('vectorOnly applies the threshold to pure cosine scores', async () => {
      await memory.remember('Alpha content');
      await memory.remember('Beta content');

      const results = await memory.recall('Alpha content', { vectorOnly: true, threshold: 0.99 });
      expect(results.length).toBeLessThanOrEqual(1);
      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('hybrid recall returns results even at threshold 0', async () => {
      await memory.remember('Alpha content');
      const results = await memory.recall('Alpha content', { threshold: 0 });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('forget and forgetAll', () => {
    it('forgets a single entry within the default namespace', async () => {
      const entry = await memory.remember('Temporary fact');
      await memory.forget(entry.id);
      expect(await memory.count()).toBe(0);
    });

    it('forgets a single entry within an explicit namespace', async () => {
      const entry = await memory.remember('Scoped fact', { namespace: 'alpha' });
      await memory.forget(entry.id, 'alpha');
      expect(await memory.count('alpha')).toBe(0);
    });

    it('forgetAll clears only the targeted namespace', async () => {
      await memory.remember('A1', { namespace: 'alpha' });
      await memory.remember('A2', { namespace: 'alpha' });
      await memory.remember('B1', { namespace: 'beta' });

      await memory.forgetAll('alpha');
      expect(await memory.count('alpha')).toBe(0);
      expect(await memory.count('beta')).toBe(1);
    });
  });

  describe('namespace isolation threads scope through forget', () => {
    it('forgets an entry remembered through the wrapper', async () => {
      const tenantA = withNamespaceIsolation(memory, { namespace: 'tenant-a' });
      const entry = await tenantA.remember('To be forgotten');
      await tenantA.forget(entry.id);
      expect(await tenantA.count()).toBe(0);
    });
  });

  describe('getMemoryStatus', () => {
    it('counts the named namespaces and sums totals', async () => {
      const storage = createInMemoryMemoryRecordStorage();
      const statusMemory = createMemory({ embedder: createMockEmbedder(DIMENSION), storage });
      await statusMemory.init();
      await statusMemory.remember('a', { namespace: 'alpha' });
      await statusMemory.remember('b', { namespace: 'alpha' });
      await statusMemory.remember('c', { namespace: 'beta' });

      const status = await getMemoryStatus(storage, { namespaces: ['alpha', 'beta'] });
      expect(status.totalEntries).toBe(3);
      expect(status.namespaces[0]).toEqual({ name: 'alpha', count: 2 });
      expect(status.namespaces[1]).toEqual({ name: 'beta', count: 1 });
    });
  });

  describe('routes vector similarity through storage.searchByVector', () => {
    const SENTINEL_SCORE = 0.42;

    /**
     * Wraps the in-memory backend and makes `searchByVector` return a sentinel
     * score that pure cosine could never produce for the stored record (whose
     * vector is identical to the query, true cosine `1`). If `createMemory`
     * recomputed cosine itself, the surfaced score would be `1`; observing the
     * sentinel proves the score came verbatim from `storage.searchByVector`.
     */
    function createSpyStorage(): {
      storage: MemoryRecordStorage;
      searchByVector: ReturnType<typeof mock>;
      list: ReturnType<typeof mock>;
    } {
      const inner = createInMemoryMemoryRecordStorage();

      const searchByVector = mock(
        async (
          vector: Parameters<MemoryRecordStorage['searchByVector']>[0],
          scope: Parameters<MemoryRecordStorage['searchByVector']>[1],
          options: Parameters<MemoryRecordStorage['searchByVector']>[2],
        ): Promise<MemoryVectorSearchResult[]> => {
          const records = await inner.list(scope);
          return records
            .map((record) => ({ id: record.id, score: SENTINEL_SCORE, record }))
            .slice(0, options.limit);
        },
      );

      const list = mock(inner.list);

      const storage: MemoryRecordStorage = {
        ...inner,
        searchByVector,
        list,
      };

      return { storage, searchByVector, list };
    }

    it('uses the storage-reported score verbatim and never recomputes cosine', async () => {
      const { storage, searchByVector } = createSpyStorage();
      const memory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage,
        // High dedup threshold so the second remember inserts rather than merges.
        deduplicationThreshold: 0.999,
      });
      await memory.init();

      await memory.remember('A record whose vector equals the query vector');

      const results = await memory.recall('A record whose vector equals the query vector', {
        vectorOnly: true,
      });

      expect(searchByVector).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      // Pure cosine of identical vectors is 1; the sentinel proves createMemory
      // surfaced the storage score rather than scoring the corpus itself.
      expect(results[0]!.score).toBeCloseTo(SENTINEL_SCORE, 10);
    });

    it('does not recompute cosine in the hybrid path either', async () => {
      const { storage, searchByVector, list } = createSpyStorage();
      const memory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage,
        deduplicationThreshold: 0.999,
        // Weight the result entirely on the vector half so the surfaced score is
        // the storage score (BM25 contributes nothing).
        defaultSearchOptions: { vectorWeight: 1, textWeight: 0 },
      });
      await memory.init();

      await memory.remember('Hybrid path record content');

      const results = await memory.recall('Hybrid path record content');

      // The vector half must come from storage.searchByVector...
      expect(searchByVector).toHaveBeenCalled();
      // ...and enumerating the corpus via list() for BM25 is allowed.
      expect(list).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      // combined = vectorWeight * sentinel + textWeight * bm25 = 1 * 0.42 + 0.
      expect(results[0]!.score).toBeCloseTo(SENTINEL_SCORE, 10);
    });
  });
});
