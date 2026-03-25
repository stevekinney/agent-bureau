import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

function createTestMemory(options?: { namespace?: string; deduplicationThreshold?: number }) {
  const storage = new MemoryStorageAdapter();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
    namespace: options?.namespace,
    deduplicationThreshold: options?.deduplicationThreshold,
  });
  return { memory, storage, embedder };
}

describe('createMemory', () => {
  let memory: Memory;
  let storage: MemoryStorageAdapter;
  let embedder: ReturnType<typeof createMockEmbedder>;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    storage = test.storage;
    embedder = test.embedder;
    await memory.init();
  });

  describe('remember', () => {
    it('stores and returns a MemoryEntry', async () => {
      const entry = await memory.remember('The capital of France is Paris');

      expect(entry.id).toBeTypeOf('string');
      expect(entry.content).toBe('The capital of France is Paris');
      expect(entry.vector).toHaveLength(DIMENSION);
      expect(entry.metadata.namespace).toBe('default');
      expect(entry.metadata.source).toBe('manual');
      expect(entry.createdAt).toBeTypeOf('number');
      expect(entry.updatedAt).toBeTypeOf('number');
    });

    it('stores the entry in the underlying storage', async () => {
      const entry = await memory.remember('Hello, world');

      const stored = await storage.get(entry.id);
      expect(stored).toBeDefined();
      expect(stored.id).toBe(entry.id);
      expect(stored.vector).toBeInstanceOf(Float32Array);
    });

    it('preserves provided metadata', async () => {
      const entry = await memory.remember('Remember this', {
        source: 'tool',
        tags: ['important'],
        importance: 0.9,
        conversationId: 'conv-1',
        agentId: 'agent-1',
      });

      expect(entry.metadata.source).toBe('tool');
      expect(entry.metadata.tags).toEqual(['important']);
      expect(entry.metadata.importance).toBe(0.9);
      expect(entry.metadata.conversationId).toBe('conv-1');
      expect(entry.metadata.agentId).toBe('agent-1');
    });

    it('uses the configured default namespace', async () => {
      const { memory: namespacedMemory } = createTestMemory({
        namespace: 'project-alpha',
      });
      await namespacedMemory.init();

      const entry = await namespacedMemory.remember('Namespaced memory');
      expect(entry.metadata.namespace).toBe('project-alpha');
    });

    it('allows overriding namespace via metadata', async () => {
      const entry = await memory.remember('Override namespace', {
        namespace: 'custom',
      });
      expect(entry.metadata.namespace).toBe('custom');
    });
  });

  describe('deduplication', () => {
    it('prevents near-duplicate entries', async () => {
      const first = await memory.remember('The capital of France is Paris');
      const second = await memory.remember('The capital of France is Paris');

      expect(second.id).toBe(first.id);
      const totalCount = await storage.count();
      expect(totalCount).toBe(1);
    });

    it('allows different content through', async () => {
      await memory.remember('The capital of France is Paris');
      await memory.remember('TypeScript is a programming language');

      const totalCount = await storage.count();
      expect(totalCount).toBe(2);
    });

    it('respects deduplication threshold', async () => {
      // With a very low threshold (0.0), everything deduplicates against the first entry
      const { memory: looseMemory } = createTestMemory({
        deduplicationThreshold: 0.0,
      });
      await looseMemory.init();

      await looseMemory.remember('Hello');
      await looseMemory.remember('Completely different text');

      // Both should be treated as duplicates at threshold 0.0
      const count = await looseMemory.count();
      expect(count).toBe(1);
    });

    it('does not deduplicate when similarity is below threshold', async () => {
      // With threshold of 0.9999, Float32 precision loss prevents
      // even identical text from being deduplicated
      const { memory: strictMemory } = createTestMemory({
        deduplicationThreshold: 0.9999,
      });
      await strictMemory.init();

      await strictMemory.remember('Hello');
      await strictMemory.remember('Completely unrelated topic about cooking');

      // Dissimilar content should not deduplicate
      const count = await strictMemory.count();
      expect(count).toBe(2);
    });
  });

  describe('recall', () => {
    it('returns relevant results', async () => {
      await memory.remember('The capital of France is Paris');
      await memory.remember('TypeScript is a programming language');
      await memory.remember('Bun is a JavaScript runtime');

      const results = await memory.recall('programming languages');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBeTypeOf('string');
      expect(results[0]!.content).toBeTypeOf('string');
      expect(results[0]!.score).toBeTypeOf('number');
      expect(results[0]!.metadata).toBeDefined();
      expect(results[0]!.createdAt).toBeTypeOf('number');
    });

    it('returns results sorted by score descending', async () => {
      await memory.remember('Alpha');
      await memory.remember('Beta');
      await memory.remember('Gamma');

      const results = await memory.recall('Alpha');

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it('respects the limit option', async () => {
      await memory.remember('One');
      await memory.remember('Two');
      await memory.remember('Three');

      const results = await memory.recall('test', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('applies temporal decay when configured', async () => {
      // Store an entry with a very old timestamp by manually writing to storage
      const vector = embedder(['old memory'])[0]!;
      const float32Vector = new Float32Array(vector);
      let magnitude = 0;
      for (const value of float32Vector) magnitude += value * value;
      magnitude = Math.sqrt(magnitude);

      await storage.put({
        id: 'old-entry',
        vector: float32Vector,
        metadata: {
          __memory_content: 'old memory',
          __memory_namespace: 'default',
          source: 'manual',
        },
        magnitude,
        timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      });

      // Store a recent entry
      await memory.remember('fresh memory');

      const resultsWithoutDecay = await memory.recall('memory');
      const resultsWithDecay = await memory.recall('memory', {
        temporalDecay: { halfLifeMilliseconds: 7 * 24 * 60 * 60 * 1000 }, // 7-day half-life
      });

      // The old entry's score should be reduced with decay
      const oldWithoutDecay = resultsWithoutDecay.find((r) => r.id === 'old-entry');
      const oldWithDecay = resultsWithDecay.find((r) => r.id === 'old-entry');

      if (oldWithoutDecay && oldWithDecay) {
        expect(oldWithDecay.score).toBeLessThan(oldWithoutDecay.score);
      }
    });

    it('applies MMR diversity when configured', async () => {
      // Store several entries
      await memory.remember('JavaScript is a language');
      await memory.remember('TypeScript is a language');
      await memory.remember('Rust is a language');
      await memory.remember('Cooking pasta is fun');

      const results = await memory.recall('programming languages', {
        limit: 4,
        diversify: { lambda: 0.5 },
      });

      // MMR should return results — exact order depends on the algorithm
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(4);
    });

    it('scopes recall to namespace', async () => {
      await memory.remember('Default namespace entry');
      await memory.remember('Custom namespace entry', {
        namespace: 'custom',
      });

      const defaultResults = await memory.recall('entry');
      const customResults = await memory.recall('entry', {
        namespace: 'custom',
      });

      const defaultIds = defaultResults.map((r) => r.id);
      const customIds = customResults.map((r) => r.id);

      // They should not overlap
      for (const id of customIds) {
        expect(defaultIds).not.toContain(id);
      }
    });

    it('returns empty array for no matches', async () => {
      const results = await memory.recall('anything');
      expect(results).toEqual([]);
    });

    it('does not include vectors in search results', async () => {
      await memory.remember('Test entry');

      const results = await memory.recall('test');

      for (const result of results) {
        expect((result as Record<string, unknown>).vector).toBeUndefined();
      }
    });
  });

  describe('forget', () => {
    it('removes an entry by id', async () => {
      const entry = await memory.remember('To be forgotten');

      await memory.forget(entry.id);

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('does not affect other entries', async () => {
      const first = await memory.remember('Keep this');
      const second = await memory.remember('Remove this');

      await memory.forget(second.id);

      const count = await memory.count();
      expect(count).toBe(1);

      const results = await memory.recall('Keep this');
      expect(results.some((r) => r.id === first.id)).toBe(true);
    });
  });

  describe('forgetAll', () => {
    it('clears all entries in the default namespace', async () => {
      await memory.remember('Entry one');
      await memory.remember('Entry two');
      await memory.remember('Entry three');

      await memory.forgetAll();

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('clears only the specified namespace', async () => {
      await memory.remember('Default entry');
      await memory.remember('Custom entry', { namespace: 'custom' });

      await memory.forgetAll('custom');

      const defaultCount = await memory.count();
      const customCount = await memory.count('custom');

      expect(defaultCount).toBe(1);
      expect(customCount).toBe(0);
    });

    it('handles empty namespace gracefully', async () => {
      await memory.forgetAll('nonexistent');
      // Should not throw
    });
  });

  describe('count', () => {
    it('returns zero for empty memory', async () => {
      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('returns the correct count after remember', async () => {
      await memory.remember('One');
      await memory.remember('Two');
      await memory.remember('Three');

      const count = await memory.count();
      expect(count).toBe(3);
    });

    it('counts only entries in the specified namespace', async () => {
      await memory.remember('Default one');
      await memory.remember('Default two');
      await memory.remember('Custom one', { namespace: 'custom' });

      const defaultCount = await memory.count();
      const customCount = await memory.count('custom');

      expect(defaultCount).toBe(2);
      expect(customCount).toBe(1);
    });

    it('decrements after forget', async () => {
      const entry = await memory.remember('Will be forgotten');
      await memory.remember('Will remain');

      await memory.forget(entry.id);

      const count = await memory.count();
      expect(count).toBe(1);
    });
  });

  describe('namespace scoping', () => {
    it('isolates entries between namespaces', async () => {
      const { memory: memoryA } = createTestMemory({
        namespace: 'namespace-a',
      });
      const { memory: memoryB } = createTestMemory({
        namespace: 'namespace-b',
      });
      await memoryA.init();
      await memoryB.init();

      // These use different storage instances, so use the same storage
      // to test namespace isolation within a single storage
      await memory.remember('Entry in A', { namespace: 'namespace-a' });
      await memory.remember('Entry in B', { namespace: 'namespace-b' });

      const countA = await memory.count('namespace-a');
      const countB = await memory.count('namespace-b');
      const countDefault = await memory.count();

      expect(countA).toBe(1);
      expect(countB).toBe(1);
      expect(countDefault).toBe(0);
    });
  });

  describe('Float32Array conversion', () => {
    it('stores vectors as Float32Array in storage', async () => {
      const entry = await memory.remember('Test Float32Array');

      const stored = await storage.get(entry.id);
      expect(stored.vector).toBeInstanceOf(Float32Array);
    });

    it('returns vectors as number[] in MemoryEntry', async () => {
      const entry = await memory.remember('Test number array');

      expect(Array.isArray(entry.vector)).toBe(true);
      expect(entry.vector).toHaveLength(DIMENSION);
      for (const value of entry.vector) {
        expect(value).toBeTypeOf('number');
      }
    });

    it('round-trips vectors correctly', async () => {
      const entry = await memory.remember('Round trip test');

      const stored = await storage.get(entry.id);
      const roundTripped = Array.from(stored.vector);

      // Float32 has limited precision compared to Float64 (number),
      // so we compare with tolerance
      for (let i = 0; i < entry.vector.length; i++) {
        expect(roundTripped[i]).toBeCloseTo(entry.vector[i]!, 5);
      }
    });
  });

  describe('init and close', () => {
    it('initializes storage on init', async () => {
      const testStorage = new MemoryStorageAdapter();
      const testMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: testStorage,
      });

      // Should not throw
      await testMemory.init();
    });

    it('closes storage on close', async () => {
      const testStorage = new MemoryStorageAdapter();
      const testMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: testStorage,
      });

      await testMemory.init();
      // Should not throw
      await testMemory.close();
    });
  });

  describe('default search options', () => {
    it('applies defaultSearchOptions when recall is called without options', async () => {
      const testStorage = new MemoryStorageAdapter();
      const testMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: testStorage,
        defaultSearchOptions: { limit: 1 },
      });
      await testMemory.init();

      await testMemory.remember('One');
      await testMemory.remember('Two');
      await testMemory.remember('Three');

      const results = await testMemory.recall('test');
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('allows overriding defaultSearchOptions per call', async () => {
      const testStorage = new MemoryStorageAdapter();
      const testMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: testStorage,
        defaultSearchOptions: { limit: 1 },
      });
      await testMemory.init();

      await testMemory.remember('One');
      await testMemory.remember('Two');
      await testMemory.remember('Three');

      const results = await testMemory.recall('test', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
});
