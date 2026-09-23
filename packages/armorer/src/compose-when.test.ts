import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { ComposedTool } from './compose-types';
import { createTool } from './create-tool';
import { type MinimalAbortSignal } from './is-tool';
import { when } from './utilities';

describe('when()', () => {
  const increment = createTool({
    name: 'increment',
    description: 'Adds 1',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value + 1 }),
  }) as ComposedTool<{ value: number }, { value: number }>;

  const double = createTool({
    name: 'double',
    description: 'Doubles',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value * 2 }),
  }) as ComposedTool<{ value: number }, { value: number }>;

  it('routes to the correct branch', async () => {
    const conditional = when(({ value }) => value > 5, increment, double);

    const low = await conditional({ value: 3 });
    const high = await conditional({ value: 6 });

    expect(low).toMatchObject({ value: 6 });
    expect(high).toMatchObject({ value: 7 });
  });

  it('passes through input when no else tool is provided', async () => {
    const conditional = when(({ value }) => value > 0, increment);

    const result = await conditional({ value: 0 });
    expect(result).toMatchObject({ value: 0 });
  });

  it('forwards execution options without aborting a settled branch', async () => {
    const observed: {
      signal?: MinimalAbortSignal | undefined;
      timeout?: number | undefined;
    } = {};
    const capture = createTool({
      name: 'capture',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.signal = context.signal;
        observed.timeout = context.timeout;
        return { value: 1 };
      },
    });

    const conditional = when(() => true, capture);
    const controller = new AbortController();
    await conditional.executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 55,
    });

    expect(observed.signal).not.toBe(controller.signal);
    controller.abort('caller stopped');
    expect(observed.signal?.aborted).toBe(false);
    expect(observed.timeout).toBe(55);
  });

  it('forwards stream to the selected branch', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'when-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return { value: 2 };
      },
    });

    const conditional = when(() => true, capture);
    const result = await conditional.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toMatchObject({ value: 2 });
    expect(observed).toEqual([{ stream: true }]);
  });
});
