import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { ComposedTool } from './compose-types';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import { isTool, type MinimalAbortSignal } from './is-tool';
import { bind, parallel, pipe, PipelineError, retry, tap, when } from './utilities';

describe('pipe()', () => {
  // Setup test tools
  const parseNumber = createTool({
    name: 'parse-number',
    description: 'Parses a string to a number',
    input: z.object({ str: z.string() }),
    execute: async ({ str }) => ({ value: parseInt(str, 10) }),
  });

  const double = createTool({
    name: 'double',
    description: 'Doubles a number',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value * 2 }),
  });

  const stringify = createTool({
    name: 'stringify',
    description: 'Converts number to formatted string',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ text: `Result: ${value}` }),
  });

  const addPrefix = createTool({
    name: 'add-prefix',
    description: 'Adds prefix to string',
    input: z.object({ text: z.string() }),
    execute: async ({ text }) => `PREFIX: ${text}`,
  });

  describe('basic functionality', () => {
    it('throws if less than 2 tools provided', () => {
      // Cast to any to bypass TypeScript's compile-time check (overloads require 2+ args)
      const pipeAny = pipe as (...tools: any[]) => any;
      expect(() => pipeAny(parseNumber)).toThrow('pipe() requires at least 2 tools');
    });

    it('creates a tool with composed name', () => {
      const pipeline = pipe(parseNumber, double);
      expect(pipeline.name).toBe('pipe(parse-number, double)');
    });

    it('creates a tool with description showing flow', () => {
      const pipeline = pipe(parseNumber, double);
      expect(pipeline.description).toBe('Composed pipeline: parse-number → double');
    });

    it('uses first tool input for validation', () => {
      const pipeline = pipe(parseNumber, double);
      expect(pipeline.input).toBe(parseNumber.input);
    });
  });

  describe('execution', () => {
    it('executes 2 tools in sequence', async () => {
      const pipeline = pipe(parseNumber, double);
      const result = await pipeline({ str: '21' });
      expect(result).toEqual({ value: 42 });
    });

    it('executes 3 tools in sequence', async () => {
      const pipeline = pipe(parseNumber, double, stringify);
      const result = await pipeline({ str: '21' });
      expect(result).toEqual({ text: 'Result: 42' });
    });

    it('executes 4 tools in sequence', async () => {
      const pipeline = pipe(parseNumber, double, stringify, addPrefix);
      const result = await pipeline({ str: '21' });
      expect(result).toBe('PREFIX: Result: 42');
    });

    it('validates input using first tool schema', async () => {
      const pipeline = pipe(parseNumber, double);
      // Pass wrong type - str should be string, not number
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: 123 } as unknown as { str: string })).rejects.toThrow();
    });

    it('validates intermediate results at each step', async () => {
      // Create a tool that returns wrong type
      const badTool = createTool({
        name: 'bad-tool',
        description: 'Returns wrong type',
        input: z.object({ str: z.string() }),
        execute: async () => ({ value: 'not a number' as unknown as number }),
      });

      const pipeline = pipe(badTool, double);
      // double expects a number, but badTool returns a string
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: 'test' })).rejects.toThrow();
    });

    it('forwards stream options through pipeline steps', async () => {
      const observed: Array<{ step: string; stream?: boolean }> = [];
      const first = createTool({
        name: 'pipe-capture-1',
        description: 'captures execution context',
        input: z.object({ str: z.string() }),
        async execute({ str }, context) {
          observed.push({
            step: 'first',
            stream: context.stream,
          });
          return { value: Number(str) };
        },
      });
      const second = createTool({
        name: 'pipe-capture-2',
        description: 'captures execution context',
        input: z.object({ value: z.number() }),
        async execute({ value }, context) {
          observed.push({
            step: 'second',
            stream: context.stream,
          });
          return { value: value + 1 };
        },
      });
      const pipeline = pipe(first, second);

      const result = await pipeline.execute(
        createToolCall(pipeline.name, { str: '5' }, 'pipe-stream'),
        {
          stream: true,
        },
      );

      expect(result.result).toEqual({ value: 6 });
      expect(observed).toEqual([
        { step: 'first', stream: true },
        { step: 'second', stream: true },
      ]);
    });
  });

  describe('signal handling', () => {
    const runWithAbortReason = async (reason: unknown) => {
      let resolveStep: ((value: { value: number }) => void) | undefined;
      let resolveReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const delayed = createTool({
        name: 'delayed',
        description: 'delays first step',
        input: z.object({ str: z.string() }),
        execute: async () =>
          new Promise<{ value: number }>((resolve) => {
            resolveStep = resolve;
            resolveReady?.();
          }),
      });
      const pipeline = pipe(delayed, double);
      const controller = new AbortController();
      const pending = pipeline.execute(createToolCall(pipeline.name, { str: '5' }), {
        signal: controller.signal,
      });
      await ready;
      if (!resolveStep) {
        throw new Error('Missing delayed step resolver');
      }
      resolveStep({ value: 1 });
      controller.abort(reason);
      return pending;
    };

    const runWithPreAbortedSignal = async (reason: unknown) => {
      const pipeline = pipe(parseNumber, double);
      const controller = new AbortController();
      controller.abort(reason);
      return pipeline.execute(createToolCall(pipeline.name, { str: '5' }), {
        signal: controller.signal,
      });
    };

    it('wraps string abort reasons as errors', async () => {
      const result = await runWithAbortReason('stop-now');
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('stop-now');
    });

    it('uses Error abort reasons directly', async () => {
      const result = await runWithAbortReason(new Error('cancelled'));
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('cancelled');
    });

    it('stringifies object abort reasons', async () => {
      const result = await runWithAbortReason({ code: 'HALT' });
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('HALT');
    });

    it('falls back when abort reasons are not serializable', async () => {
      const result = await runWithAbortReason(1n);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('1');
    });

    it('normalizes pre-aborted Error reasons', async () => {
      const result = await runWithPreAbortedSignal(new Error('pre-cancel'));
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('pre-cancel');
    });

    it('normalizes pre-aborted string reasons', async () => {
      const result = await runWithPreAbortedSignal('pre-stop');
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('pre-stop');
    });

    it('normalizes pre-aborted object reasons', async () => {
      const result = await runWithPreAbortedSignal({ code: 'PRE_ABORT' });
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('PRE_ABORT');
    });

    it('falls back for pre-aborted unserializable reasons', async () => {
      const result = await runWithPreAbortedSignal(1n);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('1');
    });

    it('normalizes aborted reasons when invoking pipeline configuration directly', async () => {
      const pipeline = pipe(parseNumber, double);
      const runWithReason = async (reason: unknown): Promise<unknown> =>
        (pipeline as any).run(
          { str: '5' },
          {
            dispatch: () => {},
            signal: {
              aborted: true,
              reason,
            } as MinimalAbortSignal,
          },
        );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runWithReason(new Error('direct-error'))).rejects.toThrow('direct-error');
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runWithReason('direct-string')).rejects.toThrow('direct-string');
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runWithReason({ code: 'DIRECT_OBJECT' })).rejects.toThrow('DIRECT_OBJECT');

      const circular: any = { code: 'DIRECT_CYCLE' };
      circular.self = circular;
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(runWithReason(circular)).rejects.toThrow('[object Object]');
    });
  });

  describe('events', () => {
    // Helper to add event listener with any event type (step events are emitted at runtime)
    const addListener = (tool: any, type: string, fn: (e: any) => void) => {
      tool.addEventListener(type, fn);
    };

    it('emits step-start events', async () => {
      const pipeline = pipe(parseNumber, double);
      const events: any[] = [];

      addListener(pipeline, 'step-start', (e) => {
        events.push(e.detail);
      });
      await pipeline({ str: '5' });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        stepIndex: 0,
        stepName: 'parse-number',
        input: { str: '5' },
      });
      expect(events[1]).toEqual({
        stepIndex: 1,
        stepName: 'double',
        input: { value: 5 },
      });
    });

    it('emits step-complete events', async () => {
      const pipeline = pipe(parseNumber, double);
      const events: any[] = [];

      addListener(pipeline, 'step-complete', (e) => {
        events.push(e.detail);
      });
      await pipeline({ str: '5' });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        stepIndex: 0,
        stepName: 'parse-number',
        output: { value: 5 },
      });
      expect(events[1]).toEqual({
        stepIndex: 1,
        stepName: 'double',
        output: { value: 10 },
      });
    });

    it('emits step-error event on failure', async () => {
      const failing = createTool({
        name: 'failing',
        description: 'Always fails',
        input: z.object({ value: z.number() }),
        execute: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const errors: any[] = [];
      addListener(pipeline, 'step-error', (e) => {
        errors.push(e.detail);
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: '5' })).rejects.toThrow();

      expect(errors).toHaveLength(1);
      expect(errors[0].stepIndex).toBe(1);
      expect(errors[0].stepName).toBe('failing');
      expect(errors[0].error).toBeInstanceOf(Error);
    });
  });

  describe('error handling', () => {
    it('includes step info in error message', async () => {
      const failing = createTool({
        name: 'failing',
        description: 'Always fails',
        input: z.object({ value: z.number() }),
        execute: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = pipe(parseNumber, failing);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: '5' })).rejects.toThrow('Pipeline failed at step 1 (failing)');
    });

    it('executeWith returns error details', async () => {
      const failing = createTool({
        name: 'failing',
        description: 'Always fails',
        input: z.object({ value: z.number() }),
        execute: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const result = await pipeline.executeWith({ params: { str: '5' } });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Pipeline failed at step 1 (failing)');
    });

    it('stringifies object errors thrown by pipeline steps', async () => {
      const failing = createTool({
        name: 'object-failing',
        description: 'throws object errors',
        input: z.object({ value: z.number() }),
        execute: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw { code: 'OBJECT_FAIL' };
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const stepErrors: Error[] = [];
      (pipeline as any).addEventListener('step-error', (event: any) => {
        stepErrors.push(event.detail.error as Error);
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: '5' })).rejects.toThrow(
        'Pipeline failed at step 1 (object-failing)',
      );
      expect(stepErrors).toHaveLength(1);
      expect(stepErrors[0]?.message).toBe(JSON.stringify({ code: 'OBJECT_FAIL' }));
    });

    it('falls back to String(error) when object errors are not serializable', async () => {
      const circular: any = { code: 'CYCLE' };
      circular.self = circular;

      const failing = createTool({
        name: 'circular-failing',
        description: 'throws circular object errors',
        input: z.object({ value: z.number() }),
        execute: async () => {
          throw circular;
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const stepErrors: Error[] = [];
      (pipeline as any).addEventListener('step-error', (event: any) => {
        stepErrors.push(event.detail.error as Error);
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pipeline({ str: '5' })).rejects.toThrow(
        'Pipeline failed at step 1 (circular-failing)',
      );
      expect(stepErrors).toHaveLength(1);
      expect(stepErrors[0]?.message).toBe('[object Object]');
    });
  });

  describe('composability', () => {
    it('composed tools can be registered in Toolbox', () => {
      const pipeline = pipe(parseNumber, double);
      const toolbox = createToolbox([pipeline]);
      const found = toolbox.getTool('pipe(parse-number, double)') as any;
      expect(found).toBeDefined();
      expect(found?.name).toBe('pipe(parse-number, double)');
    });

    it('composed tools can be further composed', async () => {
      const first = pipe(parseNumber, double);
      const second = pipe(first, stringify);

      const result = await second({ str: '10' });
      expect(result).toEqual({ text: 'Result: 20' });
    });

    it('nested pipelines have combined names', () => {
      const first = pipe(parseNumber, double);
      const second = pipe(first, stringify);

      expect(second.name).toBe('pipe(pipe(parse-number, double), stringify)');
    });
  });

  describe('tool interface surface', () => {
    it('has required tool properties', () => {
      const pipeline = pipe(parseNumber, double);

      expect(isTool(pipeline)).toBe(true);
      expect(pipeline.name).toBeDefined();
      expect(pipeline.description).toBeDefined();
      expect(pipeline.input).toBeDefined();
      expect(pipeline.configuration).toBeDefined();
      expect(typeof pipeline.execute).toBe('function');
      expect(typeof pipeline.addEventListener).toBe('function');
    });

    it('can use executeWith', async () => {
      const pipeline = pipe(parseNumber, double);
      const result = await pipeline.executeWith({
        params: { str: '21' },
      });

      expect(result.result).toEqual({ value: 42 });
      expect(result.toolName).toBe('pipe(parse-number, double)');
    });
  });
});

describe('bind()', () => {
  const sum = createTool({
    name: 'sum',
    description: 'Adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => a + b,
  });

  it('binds object parameters and requires remaining inputs', async () => {
    const addOne = bind(sum, { a: 1 }, { name: 'add-one' });
    expect(isTool(addOne)).toBe(true);
    expect(addOne.name).toBe('add-one');
    expect(addOne.input.safeParse({ b: 2 }).success).toBe(true);
    expect(addOne.input.safeParse({}).success).toBe(false);
    const result = await addOne({ b: 2 });
    expect(result).toBe(3);
  });

  it('throws when binding unknown keys', () => {
    expect(() => bind(sum, { c: 1 } as any)).toThrow(/unknown keys/);
  });

  it('throws when binding non-object to object schema', () => {
    expect(() => bind(sum, 1 as any)).toThrow(/expects an object/);
  });

  it('throws when binding a tool with a non-object schema', () => {
    const rawTool = async function rawTool(params: number) {
      return params;
    };
    (rawTool as any).description = 'raw-number';
    (rawTool as any).input = z.number();
    (rawTool as any).tags = [];
    (rawTool as any).metadata = undefined;

    expect(() => bind(rawTool as any, {} as any)).toThrow(/object schema/);
  });

  it('throws when schema does not support omit', () => {
    const schemaWithoutOmit = {
      shape: { a: z.string(), b: z.number() },
    };
    const rawTool = async function rawTool(params: { a: string; b: number }) {
      return params;
    };
    (rawTool as any).description = 'raw';
    (rawTool as any).input = schemaWithoutOmit;
    (rawTool as any).tags = [];
    (rawTool as any).metadata = undefined;

    expect(() => bind(rawTool as any, { a: 'ok' }, { name: 'raw-bound' })).toThrow(/object schema/);
  });

  it('forwards stream options to the bound tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'capture-bound',
      description: 'captures context values',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }, context) {
        observed.push({ stream: context.stream });
        return a + b;
      },
    });

    const bound = bind(capture, { a: 2 });
    const result = await (bound as any).executeWith({
      params: { b: 3 },
      stream: true,
    });

    expect(result.result).toBe(5);
    expect(observed).toEqual([{ stream: true }]);
  });
});

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
      seen.push(output.value);
    });

    const result = await tapped({ value: 2 });
    expect(result).toEqual({ value: 3 });
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
    expect((tapped as any).metadata).toEqual({ tier: 'premium' });
  });

  it('forwards signal and timeout to the wrapped tool', async () => {
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
    await (tapped as any).executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 99,
    });

    expect(observed.signal).toBe(controller.signal);
    expect(observed.timeout).toBe(99);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'tap-stream',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return { value: 1 };
      },
    });

    const tapped = tap(tool, async () => {});
    const result = await (tapped as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toEqual({ value: 1 });
    expect(observed).toEqual([{ stream: true }]);
  });
});

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

    expect(low).toEqual({ value: 6 });
    expect(high).toEqual({ value: 7 });
  });

  it('passes through input when no else tool is provided', async () => {
    const conditional = when(({ value }) => value > 0, increment);

    const result = await conditional({ value: 0 });
    expect(result).toEqual({ value: 0 });
  });

  it('forwards execution options to branch tools', async () => {
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
    await (conditional as any).executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 55,
    });

    expect(observed.signal).toBe(controller.signal);
    expect(observed.timeout).toBe(55);
  });

  it('forwards stream to the selected branch', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'when-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return { value: 2 };
      },
    });

    const conditional = when(() => true, capture);
    const result = await (conditional as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toEqual({ value: 2 });
    expect(observed).toEqual([{ stream: true }]);
  });
});

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
    (combined as any).addEventListener('step-error', (event: any) => {
      errors.push({
        stepIndex: event.detail.stepIndex,
        stepName: event.detail.stepName,
      });
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(combined({ value: 1 })).rejects.toThrow('boom');
    expect(errors).toEqual([{ stepIndex: 1, stepName: 'fail' }]);
  });

  it('forwards signal and timeout to each tool', async () => {
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
    await (combined as any).executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 25,
    });

    expect(observed).toHaveLength(2);
    for (const entry of observed) {
      expect(entry.signal).toBe(controller.signal);
      expect(entry.timeout).toBe(25);
    }
  });

  it('forwards stream to each parallel branch', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'parallel-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return { value: 1 };
      },
    });

    const combined = parallel(capture, capture);
    const result = await (combined as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toEqual([{ value: 1 }, { value: 1 }]);
    expect(observed).toEqual([{ stream: true }, { stream: true }]);
  });
});

describe('retry()', () => {
  const increment = createTool({
    name: 'increment',
    description: 'Adds 1',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value + 1 }),
  });

  it('retries until success', async () => {
    let attempts = 0;
    const flaky = createTool({
      name: 'flaky',
      description: 'Fails twice',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('boom');
        }
        return { value: value + attempts };
      },
    });

    const wrapped = retry(flaky, { attempts: 3 });
    const result = await wrapped({ value: 1 });

    expect(result).toEqual({ value: 4 });
    expect(attempts).toBe(3);
  });

  it('throws after exhausting attempts', async () => {
    let attempts = 0;
    const failing = createTool({
      name: 'failing',
      description: 'Always fails',
      input: z.object({ value: z.number() }),
      execute: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    });

    const wrapped = retry(failing, { attempts: 2 });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrapped({ value: 1 })).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });

  it('validates retry options', () => {
    expect(() => retry(increment, { attempts: 0 })).toThrow(
      'retry() expects attempts to be a positive integer',
    );
    expect(() => retry(increment, { delayMs: -1 })).toThrow(
      'retry() expects delayMs to be at least 0',
    );
    expect(() => retry(increment, { maxDelayMs: -1 })).toThrow(
      'retry() expects maxDelayMs to be at least 0',
    );
  });

  it('stops retrying when shouldRetry returns false', async () => {
    let attempts = 0;
    const failing = createTool({
      name: 'fail-fast',
      description: 'fails',
      input: z.object({ value: z.number() }),
      execute: async () => {
        attempts += 1;
        throw new Error('stop');
      },
    });

    const wrapped = retry(failing, {
      attempts: 3,
      shouldRetry: async () => false,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrapped({ value: 1 })).rejects.toThrow('stop');
    expect(attempts).toBe(1);
  });

  it('invokes onRetry and honors backoff with maxDelayMs', async () => {
    let attempts = 0;
    const flaky = createTool({
      name: 'flaky',
      description: 'fails once',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('retry me');
        }
        return { value };
      },
    });

    const retries: number[] = [];
    const wrapped = retry(flaky, {
      attempts: 2,
      delayMs: 5,
      backoff: 'exponential',
      maxDelayMs: 1,
      onRetry: async ({ attempt }) => {
        retries.push(attempt);
      },
    });

    const result = await wrapped({ value: 5 });
    expect(result).toEqual({ value: 5 });
    expect(retries).toEqual([1]);
  });

  it('normalizes non-Error throws and preserves tags/metadata', async () => {
    const unstable = createTool({
      name: 'unstable',
      description: 'throws string',
      input: z.object({ value: z.number() }),
      tags: ['unstable'],
      metadata: { tier: 'dev' },
      execute: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope';
      },
    });

    const wrapped = retry(unstable, { attempts: 2 });
    expect(wrapped.tags).toEqual(['unstable']);
    expect((wrapped as any).metadata).toEqual({ tier: 'dev' });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrapped({ value: 1 })).rejects.toThrow('nope');
  });

  it('stringifies thrown objects when retrying', async () => {
    const unstable = createTool({
      name: 'object-throw',
      description: 'throws object',
      input: z.object({ value: z.number() }),
      execute: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { code: 'OBJECT_FAIL' };
      },
    });

    const wrapped = retry(unstable, { attempts: 1 });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrapped({ value: 1 })).rejects.toThrow(JSON.stringify({ code: 'OBJECT_FAIL' }));
  });

  it('falls back when thrown objects are not serializable', async () => {
    const circular: any = { code: 'CYCLE' };
    circular.self = circular;
    const unstable = createTool({
      name: 'circular-throw',
      description: 'throws circular object',
      input: z.object({ value: z.number() }),
      execute: async () => {
        throw circular;
      },
    });

    const wrapped = retry(unstable, { attempts: 1 });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrapped({ value: 1 })).rejects.toThrow('[object Object]');
  });

  it('forwards stream options to retried executions', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'retry-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push({ stream: context.stream });
        return { value: 42 };
      },
    });

    const wrapped = retry(capture, { attempts: 1 });
    const result = await (wrapped as any).executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toEqual({ value: 42 });
    expect(observed).toEqual([{ stream: true }]);
  });
});

describe('PipelineError', () => {
  it('has correct name', () => {
    const error = new PipelineError('test', {
      stepIndex: 0,
      stepName: 'test-step',
      originalError: new Error('original'),
    });

    expect(error.name).toBe('PipelineError');
  });

  it('exposes context', () => {
    const original = new Error('original');
    const error = new PipelineError('test message', {
      stepIndex: 2,
      stepName: 'my-step',
      originalError: original,
    });

    expect(error.message).toBe('test message');
    expect(error.context.stepIndex).toBe(2);
    expect(error.context.stepName).toBe('my-step');
    expect(error.context.originalError).toBe(original);
  });
});

describe('type inference', () => {
  // These tests are primarily compile-time checks
  // If they compile, the type inference is working

  it('infers input type from first tool', async () => {
    const toNumber = createTool({
      name: 'to-number',
      description: 'Parses string to number',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ value: parseInt(value, 10) }),
    });

    const add10 = createTool({
      name: 'add-10',
      description: 'Adds 10',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ value: value + 10 }),
    });

    const pipeline = pipe(toNumber, add10);

    // TypeScript should know this expects { value: string }
    const result = await pipeline({ value: '5' });
    expect(result).toEqual({ value: 15 });
  });

  it('preserves type through multiple steps', async () => {
    interface User {
      id: string;
      name: string;
    }

    interface EnrichedUser extends User {
      enriched: true;
    }

    const fetchUser = createTool({
      name: 'fetch-user',
      description: 'Fetches user by ID',
      input: z.object({ id: z.string() }),
      execute: async ({ id }): Promise<User> => ({ id, name: 'Test User' }),
    });

    const enrichUser = createTool({
      name: 'enrich-user',
      description: 'Enriches user data',
      input: z.object({ id: z.string(), name: z.string() }),
      execute: async (user): Promise<EnrichedUser> => ({ ...user, enriched: true }),
    });

    const formatUser = createTool({
      name: 'format-user',
      description: 'Formats user for display',
      input: z.object({ id: z.string(), name: z.string(), enriched: z.boolean() }),
      execute: async (user) => `User ${user.id}: ${user.name} (enriched: ${user.enriched})`,
    });

    const pipeline = pipe(fetchUser, enrichUser, formatUser);
    const result = await pipeline({ id: 'user-123' });

    expect(result).toBe('User user-123: Test User (enriched: true)');
  });
});
