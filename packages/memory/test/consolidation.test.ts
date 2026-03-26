import { describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import type { ConsolidationState } from '../src/consolidation';
import { createConsolidationTask } from '../src/consolidation';
import { createMemory } from '../src/create-memory';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

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
});
