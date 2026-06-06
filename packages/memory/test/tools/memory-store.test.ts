import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../../src/test/index';
import { createMemoryStoreTool } from '../../src/tools/memory-store';
import type { Memory } from '../../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION });
  return { memory, storage, embedder };
}

describe('createMemoryStoreTool', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  it('creates a tool with the correct name and description', () => {
    const tool = createMemoryStoreTool(memory);
    expect(tool.name).toBe('memory_store');
    expect(tool.description).toBe('Store information in memory for later recall');
  });

  it('stores content and returns confirmation', async () => {
    const tool = createMemoryStoreTool(memory);
    const result = (await tool({ content: 'The deployment target is AWS' })) as {
      id: string;
      content: string;
      stored: boolean;
    };

    expect(result.stored).toBe(true);
    expect(result.content).toBe('The deployment target is AWS');
    expect(result.id).toBeTypeOf('string');
  });

  it('stored content is recallable', async () => {
    const tool = createMemoryStoreTool(memory);
    await tool({ content: 'The CI pipeline runs on GitHub Actions' });

    const results = await memory.recall('CI pipeline');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toBe('The CI pipeline runs on GitHub Actions');
  });

  it('sets source metadata to tool', async () => {
    const tool = createMemoryStoreTool(memory);
    await tool({ content: 'Source should be tool' });

    const results = await memory.recall('Source should be tool');
    expect(results[0]!.metadata.source).toBe('tool');
  });

  it('stores content with tags', async () => {
    const tool = createMemoryStoreTool(memory);
    await tool({ content: 'Tagged memory', tags: ['infrastructure', 'aws'] });

    const results = await memory.recall('Tagged memory');
    expect(results[0]!.metadata.tags).toEqual(['infrastructure', 'aws']);
  });

  it('stores content with importance', async () => {
    const tool = createMemoryStoreTool(memory);
    await tool({ content: 'Important fact', importance: 0.95 });

    const results = await memory.recall('Important fact');
    expect(results[0]!.metadata.importance).toBe(0.95);
  });

  it('stores content with evergreen flag', async () => {
    const tool = createMemoryStoreTool(memory);
    await tool({ content: 'Evergreen knowledge', evergreen: true });

    const results = await memory.recall('Evergreen knowledge');
    expect(results[0]!.metadata.evergreen).toBe(true);
  });
});
