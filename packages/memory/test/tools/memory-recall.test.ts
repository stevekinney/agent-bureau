import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../../src/create-memory';
import { createMockEmbedder } from '../../src/test/index';
import { createMemoryRecallTool } from '../../src/tools/memory-recall';
import type { Memory } from '../../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = new MemoryStorageAdapter();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION });
  return { memory, storage, embedder };
}

describe('createMemoryRecallTool', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  it('creates a tool with the correct name and description', () => {
    const tool = createMemoryRecallTool(memory);
    expect(tool.name).toBe('memory_recall');
    expect(tool.description).toBe('Search memory for relevant information');
  });

  it('returns results when memories exist', async () => {
    await memory.remember('TypeScript is a typed superset of JavaScript');
    await memory.remember('Bun is a fast JavaScript runtime');

    const tool = createMemoryRecallTool(memory);
    const result = await tool({ query: 'TypeScript' });

    expect(result).toHaveProperty('found', true);
    expect((result as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it('returns empty results when no memories match', async () => {
    const tool = createMemoryRecallTool(memory);
    const result = await tool({ query: 'something completely unknown' });

    expect(result).toHaveProperty('found', false);
    expect((result as { results: unknown[] }).results).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await memory.remember(`Fact number ${i} about testing`);
    }

    const tool = createMemoryRecallTool(memory);
    const result = (await tool({ query: 'testing', limit: 3 })) as {
      found: boolean;
      results: unknown[];
    };

    expect(result.found).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it('includes content and score in results', async () => {
    await memory.remember('The API uses REST endpoints');

    const tool = createMemoryRecallTool(memory);
    const result = (await tool({ query: 'REST API' })) as {
      found: boolean;
      results: Array<{ id: string; content: string; score: number; createdAt: number }>;
    };

    expect(result.found).toBe(true);
    expect(result.results[0]).toHaveProperty('id');
    expect(result.results[0]).toHaveProperty('content');
    expect(result.results[0]).toHaveProperty('score');
    expect(result.results[0]).toHaveProperty('createdAt');
  });
});
