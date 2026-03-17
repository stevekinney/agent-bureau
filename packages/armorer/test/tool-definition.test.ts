import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineTool } from '../src/core';

describe('defineTool', () => {
  it('accepts input schemas', () => {
    const tool = defineTool({
      name: 'input-shape',
      description: 'uses input',
      input: { foo: z.string() },
    });

    expect(tool.input.parse({ foo: 'bar' })).toEqual({ foo: 'bar' });
  });

  it('defaults input to an empty object', () => {
    const tool = defineTool({
      name: 'default-schema',
      description: 'defaults schema',
    });

    expect(tool.input.parse({})).toEqual({});
  });

  it('accepts object shapes as input', () => {
    const tool = defineTool({
      name: 'shape-schema',
      description: 'shape schema',
      input: { foo: z.string() },
    });

    expect(tool.input.parse({ foo: 'bar' })).toEqual({ foo: 'bar' });
  });

  it('rejects non-object Zod schemas', () => {
    expect(() =>
      defineTool({
        name: 'string-schema',
        description: 'invalid schema',
        input: z.string(),
      }),
    ).toThrow('Tool input must be a Zod object schema');
  });

  it('rejects invalid input values', () => {
    expect(() =>
      defineTool({
        name: 'invalid-schema',
        description: 'invalid schema',
        input: 123 as unknown as z.ZodTypeAny,
      }),
    ).toThrow('Tool input must be a Zod object schema or an object of Zod schemas');
  });
});
