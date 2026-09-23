import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { ComposedTool } from './compose-types';
import { createTool } from './create-tool';
import { type MinimalAbortSignal } from './is-tool';
import { tap } from './utilities';

describe('tap()', () => {
  const increment = createTool({
    name: 'increment',
    description: 'Adds 1',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value + 1 }),
  }) as ComposedTool<{ value: number }, { value: number }>;

  it('runs the effect and returns the original output', async () => {
    const seen: number[] = [];
    const tapped = tap(increment, async (output) => {
      if (!isIncrementOutput(output)) throw new Error('Expected an increment output');
      seen.push(output.value);
    });

    const result = await tapped({ value: 2 });
    expect(result).toMatchObject({ value: 3 });
    expect(seen).toEqual([3]);
  });

  it('preserves tags and metadata on the tapped tool', () => {
    const tagged = createTool({
      name: 'tagged',
      description: 'Has tags',
      input: z.object({ value: z.number() }),
      tags: ['fast'],
      metadata: { tier: 'premium' },
      execute: async ({ value }) => ({ value: value + 1 }),
    });

    const tapped = tap(tagged, () => {});
    expect(tapped.tags).toEqual(['fast']);
    expect(tapped.metadata).toMatchObject({ tier: 'premium' });
  });

  it('forwards timeout and an execution-scoped signal to the wrapped tool', async () => {
    const observed: {
      signal?: MinimalAbortSignal | undefined;
      timeout?: number | undefined;
    } = {};
    const tool = createTool({
      name: 'tap-context',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.signal = context.signal;
        observed.timeout = context.timeout;
        return { value: 1 };
      },
    });

    const tapped = tap(tool, async () => {});
    const controller = new AbortController();
    await tapped.executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 99,
    });

    expect(observed.signal).not.toBe(controller.signal);
    controller.abort('caller stopped');
    expect(observed.signal?.aborted).toBe(false);
    expect(observed.timeout).toBe(99);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'tap-stream',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return { value: 1 };
      },
    });

    const tapped = tap(tool, async () => {});
    const result = await tapped.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toMatchObject({ value: 1 });
    expect(observed).toEqual([{ stream: true }]);
  });
});

function isIncrementOutput(output: unknown): output is { value: number } {
  return (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    !(Symbol.asyncIterator in output) &&
    'value' in output &&
    typeof output.value === 'number'
  );
}
