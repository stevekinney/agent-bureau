import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { expectPromiseToReject } from './async-assertion-test-helpers';
import { createTool } from './create-tool';
import { createToolbox } from './create-toolbox';
import { isTool } from './is-tool';
import { pipe } from './utilities';

const addListener = (tool: any, type: string, fn: (event: any) => void) => {
  tool.addEventListener(type, fn);
};

describe('pipe error and interface behavior', () => {
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

      await expectPromiseToReject(pipeline({ str: '5' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow('Pipeline failed at step 1 (failing)'),
      );
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
          throw { code: 'OBJECT_FAIL' };
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const stepErrors: Error[] = [];
      addListener(pipeline, 'step-error', (event) => {
        if (!(event.error instanceof Error)) throw new Error('Expected an Error step detail');
        stepErrors.push(event.error);
      });

      await expectPromiseToReject(pipeline({ str: '5' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow('Pipeline failed at step 1 (object-failing)'),
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
      addListener(pipeline, 'step-error', (event) => {
        if (!(event.error instanceof Error)) throw new Error('Expected an Error step detail');
        stepErrors.push(event.error);
      });

      await expectPromiseToReject(pipeline({ str: '5' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow('Pipeline failed at step 1 (circular-failing)'),
      );
      expect(stepErrors).toHaveLength(1);
      expect(stepErrors[0]?.message).toBe('[object Object]');
    });
  });

  describe('composability', () => {
    it('composed tools can be registered in Toolbox', () => {
      const pipeline = pipe(parseNumber, double);
      const toolbox = createToolbox([pipeline]);
      const found = toolbox.getTool('pipe(parse-number, double)');
      expect(found).toBeDefined();
      if (!found) throw new Error('Expected the pipeline to be registered');
      expect(found.name).toBe('pipe(parse-number, double)');
    });

    it('composed tools can be further composed', async () => {
      const first = pipe(parseNumber, double);
      const second = pipe(first, stringify);

      const result = await second({ str: '10' });
      expect(result).toMatchObject({ text: 'Result: 20' });
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

      expect(result.result).toMatchObject({ value: 42 });
      expect(result.toolName).toBe('pipe(parse-number, double)');
    });
  });
});
