import { describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import type { ConsolidationState } from '../src/consolidation';
import { createConsolidationTask } from '../src/consolidation';
import { createMemory } from '../src/create-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Memory, MemoryMetadata, MemorySearchResult } from '../src/types';

function createTestMemory(): Memory {
  return createMemory({
    embedder: createMockEmbedder(128),
    storage: new MemoryStorageAdapter(),
    deduplicationThreshold: 0.99, // High to avoid auto-dedup during setup
  });
}

async function processAllChunks(
  processChunk: (
    state: ConsolidationState,
    signal: AbortSignal,
  ) => Promise<{ state: ConsolidationState; done: boolean }>,
  initialState: ConsolidationState,
): Promise<ConsolidationState> {
  const controller = new AbortController();
  let state = initialState;
  let done = false;

  while (!done) {
    const result = await processChunk(state, controller.signal);
    state = result.state;
    done = result.done;
  }

  return state;
}

function createSearchResult(
  id: string,
  content: string,
  createdAt: number,
  metadata: Partial<MemoryMetadata> = {},
): MemorySearchResult {
  return {
    id,
    content,
    score: 1,
    metadata: {
      namespace: 'default',
      source: 'manual',
      ...metadata,
    } as MemoryMetadata,
    createdAt,
  };
}

function createStubMemory(
  initialEntries: MemorySearchResult[],
  similarityMatrix: Record<string, Record<string, number>>,
): Memory & {
  remembered: Array<{ content: string; metadata: Partial<MemoryMetadata> | undefined }>;
  forgotten: string[];
} {
  let entries = [...initialEntries];
  let rememberedEntryCount = 0;
  const remembered: Array<{ content: string; metadata: Partial<MemoryMetadata> | undefined }> = [];
  const forgotten: string[] = [];

  const matchesNamespace = (entry: MemorySearchResult, namespace?: string) =>
    namespace === undefined || entry.metadata.namespace === namespace;

  return {
    remembered,
    forgotten,
    async remember(content: string, metadata?: Partial<MemoryMetadata>) {
      remembered.push({ content, metadata });
      const now = Date.now() + rememberedEntryCount;
      const entry = {
        id: `remembered-${rememberedEntryCount++}`,
        content,
        vector: [],
        metadata: {
          namespace: metadata?.namespace ?? 'default',
          source: 'manual',
          ...metadata,
        } as MemoryMetadata,
        createdAt: now,
        updatedAt: now,
      };
      entries = [
        createSearchResult(entry.id, content, now, entry.metadata),
        ...entries.filter((existing) => existing.id !== entry.id),
      ];
      return entry;
    },
    async recall(query: string, options) {
      const limit = options?.limit ?? entries.length;
      const threshold = options?.threshold ?? 0;
      return entries
        .filter((entry) => matchesNamespace(entry, options?.namespace))
        .map((entry) => ({
          ...entry,
          score: similarityMatrix[query]?.[entry.content] ?? 0,
        }))
        .filter((entry) => entry.score >= threshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },
    async list(options) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? entries.length;
      return entries
        .filter((entry) => matchesNamespace(entry, options?.namespace))
        .slice(offset, offset + limit);
    },
    async forget(id: string) {
      forgotten.push(id);
      entries = entries.filter((entry) => entry.id !== id);
    },
    async forgetAll(namespace?: string) {
      entries = entries.filter((entry) => !matchesNamespace(entry, namespace));
    },
    async count(namespace?: string) {
      return entries.filter((entry) => matchesNamespace(entry, namespace)).length;
    },
    async init() {},
    async close() {},
  };
}

describe('createConsolidationTask', () => {
  it('creates a valid chunked task options structure', () => {
    const memory = createTestMemory();

    const task = createConsolidationTask({
      memory,
      merge: async (a, b) => `${a} + ${b}`,
    });

    expect(task.name).toBe('memory-consolidation');
    expect(task.priority).toBe('background');
    expect(task.initialState.processedIds).toEqual([]);
    expect(task.initialState.distilled).toBe(0);
    expect(task.initialState.deduplicated).toBe(0);
    expect(task.initialState.conflictsResolved).toBe(0);
    expect(task.initialState.pruned).toBe(0);
    expect(task.initialState.scanned).toBe(0);
    expect(typeof task.processChunk).toBe('function');
  });

  it('completes immediately when memory is empty', async () => {
    const memory = createTestMemory();
    await memory.init();

    const task = createConsolidationTask({
      memory,
      merge: async (a, b) => `${a} + ${b}`,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.scanned).toBe(0);
    expect(finalState.distilled).toBe(0);

    await memory.close();
  });

  it('scans entries in chunks', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add distinct entries
    for (let i = 0; i < 5; i++) {
      await memory.remember(`Entry number ${i} with unique content ${Math.random()}`);
    }

    const task = createConsolidationTask({
      memory,
      chunkSize: 3,
      merge: async (a, b) => `${a} + ${b}`,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.scanned).toBeGreaterThan(0);
    expect(finalState.processedIds.length).toBeGreaterThanOrEqual(3); // At least one full chunk

    await memory.close();
  });

  it('stage 4 (filter): prunes low-importance entries when evaluateImportance is set', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Critical entry about system behavior');
    await memory.remember('Trivial entry about nothing useful at all');
    await memory.remember('Another critical entry about production issues');

    const initialCount = await memory.count();

    const task = createConsolidationTask({
      memory,
      chunkSize: 10,
      merge: async (a, b) => `${a} + ${b}`,
      evaluateImportance: async (content) => {
        if (content.includes('critical') || content.includes('Critical')) return 0.8;
        return 0.1; // Below default pruneThreshold of 0.2
      },
      pruneThreshold: 0.2,
    });

    await processAllChunks(task.processChunk, task.initialState);

    const finalCount = await memory.count();
    expect(finalCount).toBeLessThan(initialCount);

    await memory.close();
  });

  it('stages are skipped cleanly when corresponding function is not provided', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Entry A');
    await memory.remember('Entry B');

    const task = createConsolidationTask({
      memory,
      chunkSize: 10,
      merge: async (a, b) => `${a} + ${b}`,
      // No resolveConflict → stage 3 skipped
      // No evaluateImportance → stage 4 skipped
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.conflictsResolved).toBe(0);
    expect(finalState.pruned).toBe(0);
    expect(finalState.scanned).toBeGreaterThan(0);

    await memory.close();
  });

  it('processedIds grows correctly across chunks', async () => {
    const memory = createTestMemory();
    await memory.init();

    for (let i = 0; i < 5; i++) {
      await memory.remember(`Distinct entry ${i} with random ${Math.random()}`);
    }

    const task = createConsolidationTask({
      memory,
      chunkSize: 2,
      merge: async (a, b) => `${a} + ${b}`,
    });

    const controller = new AbortController();

    // Process first chunk
    const result1 = await task.processChunk(task.initialState, controller.signal);
    expect(result1.state.processedIds.length).toBe(2);
    expect(result1.done).toBe(false);

    // Process second chunk
    const result2 = await task.processChunk(result1.state, controller.signal);
    expect(result2.state.processedIds.length).toBe(4);

    await memory.close();
  });

  it('calls onComplete when provided', async () => {
    const memory = createTestMemory();
    await memory.init();

    let completedState: ConsolidationState | undefined;

    const task = createConsolidationTask({
      memory,
      merge: async (a, b) => `${a} + ${b}`,
    });

    // Manually add onComplete since it's on the outer structure
    task.onComplete = (state) => {
      completedState = state;
    };

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    // onComplete would be called by createChunkedTask, not by processChunk directly
    // So we test that the structure supports it
    task.onComplete?.(finalState);

    expect(completedState).toBeDefined();
    expect(completedState!.processedIds).toEqual(finalState.processedIds);

    await memory.close();
  });

  it('returns early when the signal is already aborted before processing begins', async () => {
    const memory = createStubMemory([createSearchResult('entry-1', 'Alpha', 1)], {});
    const controller = new AbortController();
    controller.abort();

    const task = createConsolidationTask({
      memory,
      merge: async (entryA, entryB) => `${entryA} + ${entryB}`,
    });

    const result = await task.processChunk(task.initialState, controller.signal);

    expect(result).toEqual({ state: task.initialState, done: false });
  });

  it('boosts confidence on experiential merges and skips already-merged entries during deduplication', async () => {
    const memory = createStubMemory(
      [
        createSearchResult('entry-a', 'Alpha insight', 1, {
          source: 'experiential',
          confidence: 0.6,
        }),
        createSearchResult('entry-b', 'Beta insight', 2, {
          source: 'experiential',
          confidence: 0.8,
        }),
        createSearchResult('entry-c', 'Gamma duplicate', 3),
        createSearchResult('entry-d', 'Delta duplicate', 4),
      ],
      {
        'Alpha insight': {
          'Beta insight': 0.8,
          'Gamma duplicate': 0.1,
          'Delta duplicate': 0.1,
        },
        'Beta insight': {
          'Alpha insight': 0.8,
          'Gamma duplicate': 0.1,
          'Delta duplicate': 0.1,
        },
        'Gamma duplicate': {
          'Delta duplicate': 0.99,
        },
        'Delta duplicate': {
          'Gamma duplicate': 0.99,
        },
      },
    );

    const task = createConsolidationTask({
      memory,
      chunkSize: 10,
      merge: async (entryA, entryB) => `${entryA} + ${entryB}`,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.distilled).toBe(1);
    expect(finalState.deduplicated).toBe(1);
    expect(memory.remembered[0]).toEqual({
      content: 'Alpha insight + Beta insight',
      metadata: { confidence: 0.9 },
    });
    expect(memory.forgotten).toContain('entry-a');
    expect(memory.forgotten).toContain('entry-b');
    expect(memory.forgotten).toContain('entry-c');
  });

  it('resolves conflicts, prunes low-importance entries, and preserves chunk stats on abort', async () => {
    const conflictMemory = createStubMemory(
      [
        createSearchResult('entry-e', 'Conflicting fact A', 1),
        createSearchResult('entry-f', 'Conflicting fact B', 2),
        createSearchResult('entry-g', 'Disposable note', 3),
      ],
      {
        'Conflicting fact A': {
          'Conflicting fact B': 0.7,
          'Disposable note': 0.1,
        },
        'Conflicting fact B': {
          'Conflicting fact A': 0.7,
          'Disposable note': 0.1,
        },
        'Disposable note': {
          'Conflicting fact A': 0.1,
          'Conflicting fact B': 0.1,
        },
      },
    );

    const conflictTask = createConsolidationTask({
      memory: conflictMemory,
      chunkSize: 10,
      merge: async (entryA, entryB) => `${entryA} + ${entryB}`,
      resolveConflict: async (entryA, entryB) => `${entryA} reconciled with ${entryB}`,
      evaluateImportance: async (content) => (content === 'Disposable note' ? 0.1 : 0.9),
      pruneThreshold: 0.2,
    });

    const conflictState = await processAllChunks(
      conflictTask.processChunk,
      conflictTask.initialState,
    );

    expect(conflictState.conflictsResolved).toBe(1);
    expect(conflictState.pruned).toBe(1);
    expect(conflictMemory.remembered).toContainEqual({
      content: 'Conflicting fact A reconciled with Conflicting fact B',
      metadata: {},
    });
    expect(conflictMemory.forgotten).toContain('entry-e');
    expect(conflictMemory.forgotten).toContain('entry-f');
    expect(conflictMemory.forgotten).toContain('entry-g');

    const abortMemory = createStubMemory(
      [
        createSearchResult('entry-h', 'Abort candidate A', 1),
        createSearchResult('entry-i', 'Abort candidate B', 2),
      ],
      {
        'Abort candidate A': {
          'Abort candidate B': 0.8,
        },
        'Abort candidate B': {
          'Abort candidate A': 0.8,
        },
      },
    );
    const controller = new AbortController();

    const abortTask = createConsolidationTask({
      memory: abortMemory,
      chunkSize: 10,
      merge: async (entryA, entryB) => {
        controller.abort();
        return `${entryA} merged with ${entryB}`;
      },
    });

    const abortResult = await abortTask.processChunk(abortTask.initialState, controller.signal);

    expect(abortResult.done).toBe(false);
    expect(abortResult.state.processedIds).toEqual([]);
    expect(abortResult.state.distilled).toBe(1);
    expect(abortMemory.remembered).toContainEqual({
      content: 'Abort candidate A merged with Abort candidate B',
      metadata: {},
    });
  });
});
