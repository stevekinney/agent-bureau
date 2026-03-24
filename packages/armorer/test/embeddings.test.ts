import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  getQueryEmbedding,
  getRegistryEmbedder,
  getToolEmbeddings,
  registerRegistryEmbedder,
  warmToolEmbeddings,
} from '../src/core/registry/embeddings';
import { createTool } from '../src/create-tool';

const makeTool = (name: string, overrides: Partial<Parameters<typeof createTool>[0]> = {}) =>
  createTool({
    name,
    description: `${name} tool`,
    input: z.object({}),
    execute: async () => 'ok',
    ...overrides,
  });

describe('registry embedding helpers', () => {
  it('registers and retrieves embedders', () => {
    const registry = {};
    const embed = (texts: string[]) => texts.map(() => [1]);
    registerRegistryEmbedder(registry, embed);
    expect(getRegistryEmbedder(registry)).toBe(embed);
  });

  it('stores embeddings when name is the only content', () => {
    let calls = 0;
    const embed = () => {
      calls += 1;
      return [[1]];
    };
    const tool = makeTool('empty', { description: '   ' });

    warmToolEmbeddings(tool, embed);
    expect(calls).toBe(1);
    expect(getToolEmbeddings(tool)?.length).toBe(1);
  });

  it('resolves async tool embeddings and caches them', async () => {
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const tool = makeTool('alpha');

    warmToolEmbeddings(tool, embed);
    expect(getToolEmbeddings(tool)).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getToolEmbeddings(tool)?.length).toBe(2);
  });

  it('drops tool embeddings when embedder rejects', async () => {
    const embed = async () => {
      throw new Error('embed failed');
    };
    const tool = makeTool('beta');

    warmToolEmbeddings(tool, embed);
    await Promise.resolve();

    expect(getToolEmbeddings(tool)).toBeUndefined();
  });

  it('drops mismatched embedding vector lengths', () => {
    const embed = () => [[1, 0]];
    const tool = makeTool('gamma', {
      description: 'desc',
      metadata: { tier: 'pro' },
    });

    warmToolEmbeddings(tool, embed);
    expect(getToolEmbeddings(tool)).toEqual([]);
  });

  it('ignores invalid embedding vectors', () => {
    const embed = () => [[NaN]];
    const tool = makeTool('delta', { description: 'desc' });

    warmToolEmbeddings(tool, embed);
    expect(getToolEmbeddings(tool)).toEqual([]);
  });

  it('caches sync query embeddings', () => {
    let calls = 0;
    const embed = (texts: string[]) => {
      calls += 1;
      return texts.map((text) => [text.length]);
    };

    expect(getQueryEmbedding(embed, 'hello')).toEqual([5]);
    expect(getQueryEmbedding(embed, 'hello')).toEqual([5]);
    expect(calls).toBe(1);
  });

  it('handles async query embeddings and cache pending requests', async () => {
    let resolve: ((value: number[][]) => void) | undefined;
    const embed = () =>
      new Promise<number[][]>((_resolve) => {
        resolve = _resolve;
      });

    expect(getQueryEmbedding(embed, 'async')).toBeUndefined();
    expect(getQueryEmbedding(embed, 'async')).toBeUndefined();

    resolve?.([[1, 2]]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getQueryEmbedding(embed, 'async')).toEqual([1, 2]);
  });

  it('returns undefined for empty query text', () => {
    const embed = (texts: string[]) => texts.map(() => [1]);
    expect(getQueryEmbedding(embed, '   ')).toBeUndefined();
  });

  it('clears cache entries when embedder rejects', async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw new Error('reject');
    };

    expect(getQueryEmbedding(embed, 'reject')).toBeUndefined();
    await Promise.resolve();
    expect(getQueryEmbedding(embed, 'reject')).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('drops async query embeddings when vectors are invalid', async () => {
    const embed = async () => [[]];

    expect(getQueryEmbedding(embed, 'invalid')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getQueryEmbedding(embed, 'invalid')).toBeUndefined();
  });
});
