import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { postprocess } from '../src/utilities/postprocess';
import { preprocess } from '../src/utilities/preprocess';

describe('preprocess', () => {
  it('transforms inputs before passing to the tool', async () => {
    const addNumbers = createTool({
      name: 'add-numbers',
      description: 'Add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    const addNumbersWithPreprocessing = preprocess(
      addNumbers,
      async (input: { a: string; b: string }) => ({
        a: Number(input.a),
        b: Number(input.b),
      }),
    );

    const result = await addNumbersWithPreprocessing({ a: '5', b: '3' });
    expect(result).toBe(8);
  });

  it('has correct name and description', () => {
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value * 2,
    });

    const preprocessed = preprocess(tool, async (input) => input);
    expect(preprocessed.name).toBe('preprocess(original)');
    expect(preprocessed.description).toBe('Preprocessed tool: Original tool');
  });

  it('preserves tags from original tool', async () => {
    const tool = createTool({
      name: 'tagged-tool',
      description: 'A tool with tags',
      input: z.object({ value: z.number() }),
      tags: ['math', 'utility'],
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(tool, async (input) => input);
    expect(preprocessed.tags).toEqual(['math', 'utility']);
  });

  it('preserves metadata from original tool', async () => {
    const tool = createTool({
      name: 'metadata-tool',
      description: 'A tool with metadata',
      input: z.object({ value: z.number() }),
      metadata: { category: 'test', priority: 1 },
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(tool, async (input) => input);
    expect(preprocessed.metadata).toEqual({ category: 'test', priority: 1 });
  });

  it('works with sync mapper', async () => {
    const tool = createTool({
      name: 'double',
      description: 'Double a number',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const preprocessed = preprocess(tool, (input: { str: string }) => ({
      n: parseInt(input.str, 10),
    }));

    const result = await preprocessed({ str: '10' });
    expect(result).toBe(20);
  });

  it('handles no tags gracefully', async () => {
    const tool = createTool({
      name: 'no-tags',
      description: 'A tool without tags',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(tool, async (input) => input);
    expect(preprocessed.tags).toBeUndefined();
  });

  it('forwards signal and timeout to the wrapped tool', async () => {
    const observed: { signal?: AbortSignal; timeout?: number } = {};
    const tool = createTool({
      name: 'context-forward',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.signal = context.signal;
        observed.timeout = context.timeout;
        return 1;
      },
    });

    const preprocessed = preprocess(tool, async (input) => input);
    const controller = new AbortController();
    await (preprocessed as any).executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 123,
    });

    expect(observed.signal).toBe(controller.signal);
    expect(observed.timeout).toBe(123);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'preprocess-stream-forward',
      description: 'captures stream',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return 7;
      },
    });

    const preprocessed = preprocess(tool, async (input) => input);
    const result = await (preprocessed as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toBe(7);
    expect(observed).toEqual([{ stream: true }]);
  });
});

describe('postprocess', () => {
  it('transforms outputs after tool execution', async () => {
    const fetchUser = createTool({
      name: 'fetch-user',
      description: 'Fetch user data',
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ userId: id, name: 'John' }),
    });

    const fetchUserFormatted = postprocess(fetchUser, async (output) => ({
      ...output,
      displayName: `${output.name} (${output.userId})`,
    }));

    const result = await fetchUserFormatted({ id: '123' });
    expect(result).toEqual({
      userId: '123',
      name: 'John',
      displayName: 'John (123)',
    });
  });

  it('has correct name and description', () => {
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value * 2,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.name).toBe('postprocess(original)');
    expect(postprocessed.description).toBe('Postprocessed tool: Original tool');
  });

  it('preserves tags from original tool', async () => {
    const tool = createTool({
      name: 'tagged-tool',
      description: 'A tool with tags',
      input: z.object({ value: z.number() }),
      tags: ['math', 'utility'],
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.tags).toEqual(['math', 'utility']);
  });

  it('preserves metadata from original tool', async () => {
    const tool = createTool({
      name: 'metadata-tool',
      description: 'A tool with metadata',
      input: z.object({ value: z.number() }),
      metadata: { category: 'test', priority: 1 },
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.metadata).toEqual({ category: 'test', priority: 1 });
  });

  it('works with sync mapper', async () => {
    const tool = createTool({
      name: 'double',
      description: 'Double a number',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const postprocessed = postprocess(tool, (output) => `Result: ${output}`);

    const result = await postprocessed({ n: 5 });
    expect(result).toBe('Result: 10');
  });

  it('handles no tags gracefully', async () => {
    const tool = createTool({
      name: 'no-tags',
      description: 'A tool without tags',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.tags).toBeUndefined();
  });

  it('uses same input as original tool', () => {
    const input = z.object({ value: z.number() });
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input,
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.input).toBe(input);
  });

  it('forwards signal and timeout to the wrapped tool', async () => {
    const observed: { signal?: AbortSignal; timeout?: number } = {};
    const tool = createTool({
      name: 'context-forward',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.signal = context.signal;
        observed.timeout = context.timeout;
        return 1;
      },
    });

    const postprocessed = postprocess(tool, async (output) => output);
    const controller = new AbortController();
    await (postprocessed as any).executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 321,
    });

    expect(observed.signal).toBe(controller.signal);
    expect(observed.timeout).toBe(321);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'postprocess-stream-forward',
      description: 'captures stream',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return 9;
      },
    });

    const postprocessed = postprocess(tool, async (output) => output);
    const result = await (postprocessed as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toBe(9);
    expect(observed).toEqual([{ stream: true }]);
  });
});

describe('preprocess and postprocess composition', () => {
  it('can be chained together', async () => {
    const baseTool = createTool({
      name: 'multiply',
      description: 'Multiply by 2',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const preprocessed = preprocess(baseTool, async (input: { str: string }) => ({
      n: parseInt(input.str, 10),
    }));

    const composed = postprocess(preprocessed, async (output) => `Result: ${output}`);

    const result = await composed({ str: '5' });
    expect(result).toBe('Result: 10');
  });
});
