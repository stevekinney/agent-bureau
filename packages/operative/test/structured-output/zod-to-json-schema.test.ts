import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/structured-output/zod-to-json-schema.ts';

describe('zodToJsonSchema', () => {
  it('converts z.string() to { type: "string" }', () => {
    expect(zodToJsonSchema(z.string())).toMatchObject({ type: 'string' });
  });

  it('converts z.number() to { type: "number" }', () => {
    expect(zodToJsonSchema(z.number())).toMatchObject({ type: 'number' });
  });

  it('converts z.boolean() to { type: "boolean" }', () => {
    expect(zodToJsonSchema(z.boolean())).toMatchObject({ type: 'boolean' });
  });

  it('converts z.object() with required properties', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['name', 'age']),
    });
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['name']).toMatchObject({ type: 'string' });
    expect(props['age']).toMatchObject({ type: 'number' });
  });

  it('converts z.object() with optional properties', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.optional(z.string()),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: 'object' });
    const required = result['required'] as string[];
    expect(required).toContain('name');
    expect(required).not.toContain('nickname');
  });

  it('converts z.array() with items', () => {
    const schema = z.array(z.string());
    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts z.enum() to { type: "string", enum: [...] }', () => {
    const schema = z.enum(['red', 'green', 'blue']);
    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('converts z.literal() with a string to { const: value }', () => {
    expect(zodToJsonSchema(z.literal('hello'))).toMatchObject({ const: 'hello' });
  });

  it('converts z.literal() with a number to { const: value }', () => {
    expect(zodToJsonSchema(z.literal(42))).toMatchObject({ const: 42 });
  });

  it('converts z.literal() with a boolean to { const: value }', () => {
    expect(zodToJsonSchema(z.literal(true))).toMatchObject({ const: true });
  });

  it('converts z.union() to { anyOf: [...] }', () => {
    const schema = z.union([z.string(), z.number()]);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('anyOf');
    const anyOf = result['anyOf'] as Array<Record<string, unknown>>;
    expect(anyOf).toHaveLength(2);
    expect(anyOf[0]).toMatchObject({ type: 'string' });
    expect(anyOf[1]).toMatchObject({ type: 'number' });
  });

  it('handles nested objects recursively', () => {
    const schema = z.object({
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: 'object' });
    // The nested object may be inlined or referenced via $defs
    expect(result['properties']).toBeDefined();
  });

  it('handles arrays of objects', () => {
    const schema = z.array(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    );
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: 'array' });
    expect(result['items']).toBeDefined();
  });

  it('strips $schema and ~standard metadata', () => {
    const result = zodToJsonSchema(z.string());
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('~standard');
  });
});
