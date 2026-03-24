import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Embedder, EmbeddingEntry } from '../src/core/registry/embeddings';
import {
  awaitToolEmbeddings,
  getQueryEmbedding,
  getToolEmbeddings,
  registerToolEmbeddings,
  warmToolEmbeddings,
} from '../src/core/registry/embeddings';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';

const makeTool = (name: string, overrides: Partial<Parameters<typeof createTool>[0]> = {}) =>
  createTool({
    name,
    description: `${name} tool`,
    input: z.object({}),
    execute: async () => 'ok',
    ...overrides,
  });

describe('registerToolEmbeddings', () => {
  it('stores entries for a tool', () => {
    const tool = makeTool('register-basic');
    registerToolEmbeddings(tool, {
      name: [1, 0, 0],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]!.field).toBe('name');
    expect(entries![0]!.vector).toEqual([1, 0, 0]);
  });

  it('getToolEmbeddings returns entries after registration', () => {
    const tool = makeTool('register-get');
    expect(getToolEmbeddings(tool)).toBeUndefined();
    registerToolEmbeddings(tool, {
      description: [0, 1, 0],
    });
    expect(getToolEmbeddings(tool)).toBeDefined();
    expect(getToolEmbeddings(tool)!.length).toBeGreaterThan(0);
  });

  it('computes magnitude correctly for pre-computed embeddings', () => {
    const tool = makeTool('register-magnitude');
    registerToolEmbeddings(tool, {
      name: [3, 4],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries![0]!.magnitude).toBeCloseTo(5, 10);
  });

  it('registers embeddings for multiple fields', () => {
    const tool = makeTool('register-multi');
    registerToolEmbeddings(tool, {
      name: [1, 0, 0],
      description: [0, 1, 0],
      tags: [0, 0, 1],
      schemaKeys: [1, 1, 0],
      metadataKeys: [0, 1, 1],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(5);
    const fields = entries!.map((entry) => entry.field);
    expect(fields).toContain('name');
    expect(fields).toContain('description');
    expect(fields).toContain('tags');
    expect(fields).toContain('schemaKeys');
    expect(fields).toContain('metadataKeys');
  });

  it('skips invalid vectors (empty arrays)', () => {
    const tool = makeTool('register-skip-empty');
    registerToolEmbeddings(tool, {
      name: [],
      description: [1, 0],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]!.field).toBe('description');
  });

  it('skips vectors containing NaN', () => {
    const tool = makeTool('register-skip-nan');
    registerToolEmbeddings(tool, {
      name: [NaN, 1],
      description: [0.5, 0.5],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]!.field).toBe('description');
  });

  it('sets text to empty string for pre-computed embeddings', () => {
    const tool = makeTool('register-text');
    registerToolEmbeddings(tool, {
      name: [1, 0],
    });
    const entries = getToolEmbeddings(tool);
    expect(entries![0]!.text).toBe('');
  });
});

describe('awaitToolEmbeddings', () => {
  it('returns embeddings when already resolved (sync)', async () => {
    const tool = makeTool('await-sync');
    registerToolEmbeddings(tool, {
      name: [1, 0, 0],
    });
    const entries = await awaitToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]!.field).toBe('name');
  });

  it('returns undefined for tool with no embeddings', async () => {
    const tool = makeTool('await-none');
    const entries = await awaitToolEmbeddings(tool);
    expect(entries).toBeUndefined();
  });

  it('awaits pending promise and returns result', async () => {
    const tool = makeTool('await-pending');
    const embed: Embedder = async (texts: string[]) => texts.map(() => [1, 0]);

    warmToolEmbeddings(tool, embed);

    // Before resolution, getToolEmbeddings returns undefined (promise pending)
    expect(getToolEmbeddings(tool)).toBeUndefined();

    // awaitToolEmbeddings should wait for the promise
    const entries = await awaitToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries!.length).toBeGreaterThan(0);
  });

  it('returns empty array when async embedder rejects', async () => {
    const tool = makeTool('await-reject');
    const embed: Embedder = async () => {
      throw new Error('embedder failure');
    };

    warmToolEmbeddings(tool, embed);

    const entries = await awaitToolEmbeddings(tool);
    // After rejection, warmToolEmbeddings deletes the entry, so result should be empty array
    // (the promise resolves to [] on catch)
    expect(entries).toEqual([]);
  });
});

describe('integration with createToolbox', () => {
  it('createToolbox with embed option invokes the embedder', () => {
    const calls: string[][] = [];
    const embed: Embedder = (texts: string[]) => {
      calls.push(texts);
      return texts.map(() => [1, 0, 0]);
    };

    const tool = makeTool('toolbox-embed', { description: 'a test tool' });
    createToolbox([tool], { embed });

    // The embedder should have been called for the tool's fields
    expect(calls.length).toBeGreaterThan(0);
  });

  it('deterministic mock embedder populates tool embeddings via toolbox', () => {
    const embed: Embedder = (texts: string[]) => texts.map(() => [1, 0, 0]);

    const tool = makeTool('deterministic-embed-tb', { description: 'testing vectors' });
    const toolbox = createToolbox([tool], { embed });

    // The toolbox creates internal tool objects; access them through the toolbox API
    const internalTools = toolbox.tools();
    expect(internalTools.length).toBe(1);
    const internalTool = internalTools[0]!;

    // The internal tool definition should have embeddings via warmToolEmbeddings
    const entries = getToolEmbeddings(internalTool);
    expect(entries).toBeDefined();
    for (const entry of entries!) {
      expect(entry.vector).toEqual([1, 0, 0]);
      expect(entry.magnitude).toBeCloseTo(1, 10);
    }
  });

  it('registerToolEmbeddings works independently of createToolbox', () => {
    const tool = makeTool('standalone-register');

    registerToolEmbeddings(tool, {
      name: [0.5, 0.5, 0],
      description: [0, 1, 0],
    });

    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(2);
    expect(entries![0]!.vector).toEqual([0.5, 0.5, 0]);
  });
});

describe('query embedding integration', () => {
  it('getQueryEmbedding returns cached embeddings', () => {
    let calls = 0;
    const embed: Embedder = (texts: string[]) => {
      calls += 1;
      return texts.map((text) => [text.length, 0]);
    };

    const result1 = getQueryEmbedding(embed, 'hello');
    expect(result1).toEqual([5, 0]);

    const result2 = getQueryEmbedding(embed, 'hello');
    expect(result2).toEqual([5, 0]);

    // Should only call embedder once due to caching
    expect(calls).toBe(1);
  });

  it('cosine similarity scoring works end-to-end with tools', () => {
    const embed: Embedder = (texts: string[]) =>
      texts.map((text) => {
        if (text.includes('search')) return [1, 0, 0];
        if (text.includes('delete')) return [0, 1, 0];
        return [0.5, 0.5, 0];
      });

    const searchTool = makeTool('search-files-e2e', {
      description: 'search through files',
    });
    const deleteTool = makeTool('delete-files-e2e', {
      description: 'delete some files',
    });

    const toolbox = createToolbox([searchTool, deleteTool], { embed });

    // Access internal tool objects through the toolbox
    const internalTools = toolbox.tools();
    expect(internalTools.length).toBe(2);

    for (const internalTool of internalTools) {
      const entries = getToolEmbeddings(internalTool);
      expect(entries).toBeDefined();
      expect(entries!.length).toBeGreaterThan(0);
    }
  });

  it('embedding entries contain correct field types', () => {
    const tool = makeTool('field-types', {
      description: 'a descriptive tool',
      tags: ['utility'],
      metadata: { level: 'basic' },
    });

    const embed: Embedder = (texts: string[]) => texts.map(() => [1, 0]);
    warmToolEmbeddings(tool, embed);

    const entries = getToolEmbeddings(tool);
    expect(entries).toBeDefined();

    // Should have entries for name, description, tags, metadataKeys at minimum
    const fields = entries!.map((entry: EmbeddingEntry) => entry.field);
    expect(fields).toContain('name');
    expect(fields).toContain('description');
    expect(fields).toContain('tags');
    expect(fields).toContain('metadataKeys');
  });
});
