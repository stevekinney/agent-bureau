import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/structured-output/zod-to-json-schema.ts';

describe('zodToJsonSchema', () => {
  it('converts z.string() to { type: "string" }', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  it('converts z.number() to { type: "number" }', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('converts z.boolean() to { type: "boolean" }', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('converts z.object() with required properties', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    });
  });

  it('converts z.object() with optional properties', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.optional(z.string()),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
      },
      required: ['name'],
    });
  });

  it('converts z.array() with items', () => {
    const schema = z.array(z.string());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts z.enum() to { type: "string", enum: [...] }', () => {
    const schema = z.enum(['red', 'green', 'blue']);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('converts z.literal() with a string to { const: value }', () => {
    expect(zodToJsonSchema(z.literal('hello'))).toEqual({ const: 'hello' });
  });

  it('converts z.literal() with a number to { const: value }', () => {
    expect(zodToJsonSchema(z.literal(42))).toEqual({ const: 42 });
  });

  it('converts z.literal() with a boolean to { const: value }', () => {
    expect(zodToJsonSchema(z.literal(true))).toEqual({ const: true });
  });

  it('converts z.union() to { anyOf: [...] }', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('handles nested objects recursively', () => {
    const schema = z.object({
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
          required: ['street', 'city'],
        },
      },
      required: ['address'],
    });
  });

  it('handles arrays of objects', () => {
    const schema = z.array(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    );
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      },
    });
  });

  it('returns an empty object for unsupported schema types', () => {
    // z.any() is not explicitly handled — falls through to the default
    expect(zodToJsonSchema(z.any())).toEqual({});
  });
});
