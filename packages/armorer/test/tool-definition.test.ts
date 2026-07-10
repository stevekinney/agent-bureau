import { describe, expect, it } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { defineTool } from '../src/core';
import { serializeToolDefinition } from '../src/core/serialization';

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value: value as { name: string } };
      },
    },
  };
}

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

  it('rejects a non-Zod Standard Schema input without an `inputJsonSchema`', () => {
    // `defineTool` is exported from the public `armorer/core` subpath, so a
    // direct caller can bypass `createTool`'s equivalent guard. Without this
    // check, `serializeToolDefinition` silently degrades the tool's
    // advertised schema to `{}` (accepts anything) instead of failing fast —
    // see the neuter check below.
    expect(() =>
      defineTool({
        name: 'greet-core-missing-schema',
        description: 'greet',
        input: greetingSchema(),
      }),
    ).toThrow('requires an explicit `inputJsonSchema`');
  });

  it('NEUTER CHECK: without the guard, a Standard Schema input silently serializes to an empty JSON Schema', () => {
    // Prove the guard is load-bearing: bypassing `inputJsonSchema` entirely
    // and serializing directly would otherwise produce `{}` — an "accept
    // anything" schema advertised to providers — rather than throwing.
    const definitionWithoutGuard = {
      identity: { name: 'greet-core-unguarded', namespace: 'default' },
      id: 'default/greet-core-unguarded' as never,
      display: { title: 'greet-core-unguarded', description: 'greet' },
      name: 'greet-core-unguarded',
      description: 'greet',
      input: z.any().transform(async (value) => value),
    };
    const serialized = serializeToolDefinition(definitionWithoutGuard);
    expect(serialized.input).toEqual({ $schema: 'https://json-schema.org/draft/2020-12/schema' });
  });

  it('accepts a non-Zod Standard Schema input when `inputJsonSchema` is supplied', () => {
    const tool = defineTool({
      name: 'greet-core',
      description: 'greet',
      input: greetingSchema(),
      inputJsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(() => serializeToolDefinition(tool)).not.toThrow();
    expect(serializeToolDefinition(tool).input).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });
});
