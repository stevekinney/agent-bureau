import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from './async-assertion-test-helpers';

import { createTool, createToolCall } from './create-tool';
import { pipe } from './utilities';

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
      expect(result).toMatchObject({ value: 42 });
    });

    it('executes 3 tools in sequence', async () => {
      const pipeline = pipe(parseNumber, double, stringify);
      const result = await pipeline({ str: '21' });
      expect(result).toMatchObject({ text: 'Result: 42' });
    });

    it('executes 4 tools in sequence', async () => {
      const pipeline = pipe(parseNumber, double, stringify, addPrefix);
      const result = await pipeline({ str: '21' });
      expect(result).toBe('PREFIX: Result: 42');
    });

    it('validates input using first tool schema', async () => {
      const pipeline = pipe(parseNumber, double);
      // Pass wrong type - str should be string, not number
      await expectPromiseToReject(pipeline({ str: 123 }), (error) =>
        expect(() => {
          throw error;
        }).toThrow(),
      );
    });

    it('validates intermediate results at each step', async () => {
      // Create a tool that returns wrong type
      const badTool = createTool({
        name: 'bad-tool',
        description: 'Returns wrong type',
        input: z.object({ str: z.string() }),
        execute: async (): Promise<unknown> => ({ value: 'not a number' }),
      });

      const pipeline = pipe(badTool, double);
      // double expects a number, but badTool returns a string
      await expectPromiseToReject(pipeline({ str: 'test' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow(),
      );
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
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
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
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
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

      expect(result.result).toMatchObject({ value: 6 });
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
      const runWithReason = async (reason: unknown): Promise<unknown> => {
        const controller = new AbortController();
        controller.abort(reason);
        return pipeline.run(
          { str: '5' },
          {
            dispatch: () => true,
            progress: () => {},
            signal: controller.signal,
            toolCall: createToolCall(pipeline.name, { str: '5' }),
            configuration: pipeline.configuration,
          },
        );
      };

      await expectPromiseToReject(runWithReason(new Error('direct-error')), (error) =>
        expect(() => {
          throw error;
        }).toThrow('direct-error'),
      );
      await expectPromiseToReject(runWithReason('direct-string'), (error) =>
        expect(() => {
          throw error;
        }).toThrow('direct-string'),
      );
      await expectPromiseToReject(runWithReason({ code: 'DIRECT_OBJECT' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow('DIRECT_OBJECT'),
      );

      const circular: any = { code: 'DIRECT_CYCLE' };
      circular.self = circular;
      await expectPromiseToReject(runWithReason(circular), (error) =>
        expect(() => {
          throw error;
        }).toThrow('[object Object]'),
      );
    });
  });
});
