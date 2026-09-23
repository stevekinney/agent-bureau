import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from './create-tool';
import { isTool } from './is-tool';
import { bind } from './utilities';

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
    const unknownBound: unknown = { c: 1 };
    expect(() => bind(sum, unknownBound)).toThrow(/unknown keys/);
  });

  it('throws when binding non-object to object schema', () => {
    const primitiveBound: unknown = 1;
    expect(() => bind(sum, primitiveBound)).toThrow(/expects an object/);
  });

  it('throws when binding a tool with a non-object schema', () => {
    const rawTool = createTool({
      name: 'raw-number',
      description: 'raw-number',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });
    Object.defineProperty(rawTool, 'input', { value: z.number() });

    expect(() => bind(rawTool, {})).toThrow(/object schema/);
  });

  it('throws when schema does not support omit', () => {
    const schemaWithoutOmit = {
      shape: { a: z.string(), b: z.number() },
    };
    const rawTool = createTool({
      name: 'raw',
      description: 'raw',
      input: z.object({ a: z.string(), b: z.number() }),
      execute: async (params) => params,
    });
    Object.defineProperty(rawTool, 'input', { value: schemaWithoutOmit });

    expect(() => bind(rawTool, { a: 'ok' }, { name: 'raw-bound' })).toThrow(/object schema/);
  });

  it('forwards stream options to the bound tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'capture-bound',
      description: 'captures context values',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return a + b;
      },
    });

    const bound = bind(capture, { a: 2 });
    const result = await bound.executeWith({
      params: { b: 3 },
      stream: true,
    });

    expect(result.result).toBe(5);
    expect(observed).toEqual([{ stream: true }]);
  });
});
