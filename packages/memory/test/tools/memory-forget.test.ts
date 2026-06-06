import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../../src/test/index';
import { createMemoryForgetTool } from '../../src/tools/memory-forget';
import type { Memory } from '../../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION });
  return { memory, storage, embedder };
}

describe('createMemoryForgetTool', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  it('creates a tool with the correct name and description', () => {
    const tool = createMemoryForgetTool(memory);
    expect(tool.name).toBe('memory_forget');
    expect(tool.description).toBe('Remove a specific memory entry');
  });

  it('deletes a memory entry by id', async () => {
    const entry = await memory.remember('Temporary fact to forget');
    const initialCount = await memory.count();
    expect(initialCount).toBe(1);

    const tool = createMemoryForgetTool(memory);
    const result = (await tool({ id: entry.id })) as { deleted: boolean; id: string };

    expect(result.deleted).toBe(true);
    expect(result.id).toBe(entry.id);

    const count = await memory.count();
    expect(count).toBe(0);
  });

  it('deletes only the specified entry', async () => {
    const entry1 = await memory.remember('First memory');
    const entry2 = await memory.remember('Second memory');
    expect(await memory.count()).toBe(2);

    const tool = createMemoryForgetTool(memory);
    await tool({ id: entry1.id });

    expect(await memory.count()).toBe(1);

    const results = await memory.recall('Second memory');
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(entry2.id);
  });
});
