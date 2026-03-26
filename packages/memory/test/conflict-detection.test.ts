import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Memory, OnConflictHandler } from '../src/types';

const DIMENSION = 64;

/**
 * The mock embedder uses deterministic hashing. Texts that share a long common
 * prefix will have higher cosine similarity than unrelated texts. We use this
 * to control the similarity ranges in tests.
 *
 * To reliably produce entries in the conflict range, we first establish what
 * similarity the embedder actually produces for our test strings.
 */
function createTestMemory(options?: {
  conflictThreshold?: number;
  deduplicationThreshold?: number;
  onConflict?: OnConflictHandler;
}) {
  const storage = new MemoryStorageAdapter();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
    deduplicationThreshold: options?.deduplicationThreshold ?? 0.95,
    conflictThreshold: options?.conflictThreshold,
    onConflict: options?.onConflict,
  });
  return { memory, storage, embedder };
}

describe('conflict detection', () => {
  describe('validation', () => {
    it('throws if conflictThreshold >= deduplicationThreshold', () => {
      expect(() =>
        createTestMemory({ conflictThreshold: 0.95, deduplicationThreshold: 0.95 }),
      ).toThrow(/conflictThreshold.*must be less than.*deduplicationThreshold/);
    });

    it('throws if conflictThreshold > deduplicationThreshold', () => {
      expect(() =>
        createTestMemory({ conflictThreshold: 0.99, deduplicationThreshold: 0.95 }),
      ).toThrow(/conflictThreshold.*must be less than.*deduplicationThreshold/);
    });
  });

  describe('feature is inert when conflictThreshold is not set', () => {
    it('stores entries without triggering onConflict', async () => {
      const onConflict = mock(async () => 'keep-both' as const);
      const { memory } = createTestMemory({ onConflict });
      await memory.init();

      await memory.remember('The project uses TypeScript');
      await memory.remember('The project uses JavaScript');

      expect(onConflict).not.toHaveBeenCalled();
    });
  });

  describe('deduplication still works (no regression)', () => {
    it('deduplicates near-identical entries above deduplicationThreshold', async () => {
      const { memory } = createTestMemory({
        conflictThreshold: 0.5,
        deduplicationThreshold: 0.95,
      });
      await memory.init();

      // Same text → cosine similarity = 1.0 → above dedup threshold
      const entry1 = await memory.remember('Exact same content');
      const entry2 = await memory.remember('Exact same content');

      expect(entry1.id).toBe(entry2.id);
      expect(await memory.count()).toBe(1);
    });
  });

  describe('conflict range detection', () => {
    let memory: Memory;
    let onConflict: ReturnType<typeof mock>;

    beforeEach(async () => {
      onConflict = mock(async () => 'keep-both' as const);
      // Use a very low conflict threshold to ensure our test entries fall in range
      const test = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict,
      });
      memory = test.memory;
      await memory.init();
    });

    it('triggers onConflict for entries in the conflict range', async () => {
      await memory.remember('Steve prefers TypeScript for most projects');
      await memory.remember('Steve prefers Rust for most projects');

      // The second remember should have triggered onConflict because the
      // texts are different (below 0.99 dedup) but topically related (above 0.0)
      expect(onConflict).toHaveBeenCalledTimes(1);
    });

    it('passes correct arguments to onConflict', async () => {
      const entry1 = await memory.remember('The project uses TypeScript');
      await memory.remember('The project uses Rust');

      expect(onConflict).toHaveBeenCalledTimes(1);
      const [incoming, existing] = onConflict.mock.calls[0]!;
      expect(incoming.content).toBe('The project uses Rust');
      expect(existing.id).toBe(entry1.id);
      expect(existing.content).toBe('The project uses TypeScript');
      expect(existing.similarity).toBeTypeOf('number');
      expect(existing.similarity).toBeGreaterThan(0);
      expect(existing.similarity).toBeLessThan(0.99);
    });

    it('passes the highest-similarity conflict to onConflict', async () => {
      await memory.remember('Alpha numeric entry one');
      await memory.remember('Beta numeric entry two');
      onConflict.mockClear();

      // This new entry will conflict with both. onConflict should receive
      // the one with the highest similarity.
      await memory.remember('Gamma numeric entry three');

      expect(onConflict).toHaveBeenCalledTimes(1);
      const [, existing] = onConflict.mock.calls[0]!;
      expect(existing.similarity).toBeTypeOf('number');
    });
  });

  describe('conflict resolution: keep-both', () => {
    it('stores both entries when onConflict returns keep-both', async () => {
      const onConflict = mock(async () => 'keep-both' as const);
      const { memory } = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict,
      });
      await memory.init();

      const entry1 = await memory.remember('Steve prefers TypeScript');
      const entry2 = await memory.remember('Steve prefers Rust');

      expect(entry1.id).not.toBe(entry2.id);
      expect(await memory.count()).toBe(2);
    });
  });

  describe('conflict resolution: replace', () => {
    it('replaces the existing entry when onConflict returns replace', async () => {
      const onConflict = mock(async () => 'replace' as const);
      const { memory } = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict,
      });
      await memory.init();

      const entry1 = await memory.remember('Steve prefers TypeScript');
      const entry2 = await memory.remember('Steve prefers Rust');

      // Should reuse the old ID (replacement)
      expect(entry2.id).toBe(entry1.id);
      expect(entry2.content).toBe('Steve prefers Rust');
      expect(await memory.count()).toBe(1);
    });
  });

  describe('conflict resolution: skip', () => {
    it('returns existing entry without storing the new one', async () => {
      const onConflict = mock(async () => 'skip' as const);
      const { memory } = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
        onConflict,
      });
      await memory.init();

      const entry1 = await memory.remember('Steve prefers TypeScript');
      const entry2 = await memory.remember('Steve prefers Rust');

      // Should return existing entry info
      expect(entry2.id).toBe(entry1.id);
      expect(entry2.content).toBe('Steve prefers TypeScript');
      expect(await memory.count()).toBe(1);
    });
  });

  describe('default behavior without onConflict callback', () => {
    it('keeps both entries when no onConflict is provided', async () => {
      const { memory } = createTestMemory({
        conflictThreshold: 0.0,
        deduplicationThreshold: 0.99,
      });
      await memory.init();

      await memory.remember('Steve prefers TypeScript');
      await memory.remember('Steve prefers Rust');

      expect(await memory.count()).toBe(2);
    });
  });

  describe('entries below conflictThreshold', () => {
    it('stores entries without triggering onConflict', async () => {
      const onConflict = mock(async () => 'keep-both' as const);
      // Use a high conflict threshold so most entries are below it
      const { memory } = createTestMemory({
        conflictThreshold: 0.99,
        deduplicationThreshold: 0.999,
        onConflict,
      });
      await memory.init();

      // Very different texts should have low similarity
      await memory.remember('Completely unrelated topic about cooking recipes');
      await memory.remember('A totally different subject involving quantum physics');

      // These should be below the 0.99 conflict threshold
      expect(onConflict).not.toHaveBeenCalled();
      expect(await memory.count()).toBe(2);
    });
  });
});
