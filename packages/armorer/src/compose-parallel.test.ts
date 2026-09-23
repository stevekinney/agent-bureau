import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from './async-assertion-test-helpers';

import { createTool } from './create-tool';
import { type MinimalAbortSignal } from './is-tool';
import { parallel } from './utilities';

const addListener = (tool: any, type: string, fn: (event: any) => void) => {
  tool.addEventListener(type, fn);
};

describe('parallel()', () => {
  const increment = createTool({
    name: 'increment',
    description: 'Adds 1',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value + 1 }),
  });

  const double = createTool({
    name: 'double',
    description: 'Doubles',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value * 2 }),
  });

  it('runs tools in parallel and returns results in order', async () => {
    const combined = parallel(increment, double);
    const result = await combined({ value: 4 });

    expect(result).toEqual([{ value: 5 }, { value: 8 }]);
  });

  it('throws when fewer than 2 tools are provided', () => {
    const parallelAny = parallel as (...tools: any[]) => any;
    expect(() => parallelAny(increment)).toThrow('parallel() requires at least 2 tools');
  });

  it('emits step-error when a tool fails', async () => {
    const fail = createTool({
      name: 'fail',
      description: 'Fails',
      input: z.object({ value: z.number() }),
      execute: async () => {
        throw new Error('boom');
      },
    });

    const combined = parallel(increment, fail);
    const errors: Array<{ stepIndex: number; stepName: string }> = [];
    addListener(combined, 'step-error', (event) => {
      errors.push({
        stepIndex: event.stepIndex,
        stepName: event.stepName,
      });
    });

    await expectPromiseToReject(combined({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('boom'),
    );
    expect(errors).toEqual([{ stepIndex: 1, stepName: 'fail' }]);
  });

  it('forwards timeout and execution-scoped signals to each tool', async () => {
    const observed: Array<{
      signal?: MinimalAbortSignal | undefined;
      timeout?: number | undefined;
    }> = [];
    const capture = createTool({
      name: 'capture',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ signal: context.signal, timeout: context.timeout });
        return { value: 1 };
      },
    });

    const combined = parallel(capture, capture);
    const controller = new AbortController();
    await combined.executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 25,
    });

    expect(observed).toHaveLength(2);
    for (const entry of observed) {
      expect(entry.signal).not.toBe(controller.signal);
      expect(entry.timeout).toBe(25);
    }
    controller.abort('caller stopped');
    for (const entry of observed) expect(entry.signal?.aborted).toBe(false);
  });

  it('forwards stream to each parallel branch', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'parallel-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return { value: 1 };
      },
    });

    const combined = parallel(capture, capture);
    const result = await combined.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toEqual([{ value: 1 }, { value: 1 }]);
    expect(observed).toEqual([{ stream: true }, { stream: true }]);
  });
});
