import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { OutputSchemaConversionError } from '../../src/errors.ts';
import { toOutputJsonSchema } from '../../src/structured-output/response-schema.ts';

describe('toOutputJsonSchema', () => {
  it('converts z.string() to { type: "string" }', () => {
    expect(toOutputJsonSchema(z.string())).toMatchObject({ type: 'string' });
  });

  it('converts z.number() to { type: "number" }', () => {
    expect(toOutputJsonSchema(z.number())).toMatchObject({ type: 'number' });
  });

  it('converts z.boolean() to { type: "boolean" }', () => {
    expect(toOutputJsonSchema(z.boolean())).toMatchObject({ type: 'boolean' });
  });

  it('converts z.object() with required properties', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = toOutputJsonSchema(schema);
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
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({ type: 'object' });
    const required = result['required'] as string[];
    expect(required).toContain('name');
    expect(required).not.toContain('nickname');
  });

  it('converts z.array() with items', () => {
    const schema = z.array(z.string());
    expect(toOutputJsonSchema(schema)).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts z.enum() to { type: "string", enum: [...] }', () => {
    const schema = z.enum(['red', 'green', 'blue']);
    expect(toOutputJsonSchema(schema)).toMatchObject({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('converts z.literal() with a string to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal('hello'))).toMatchObject({ const: 'hello' });
  });

  it('converts z.literal() with a number to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal(42))).toMatchObject({ const: 42 });
  });

  it('converts z.literal() with a boolean to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal(true))).toMatchObject({ const: true });
  });

  it('converts z.union() to { anyOf: [...] }', () => {
    const schema = z.union([z.string(), z.number()]);
    const result = toOutputJsonSchema(schema);
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
    const result = toOutputJsonSchema(schema);
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
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({ type: 'array' });
    expect(result['items']).toBeDefined();
  });

  it('strips $schema and ~standard metadata', () => {
    const result = toOutputJsonSchema(z.string());
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('~standard');
  });

  it('throws OutputSchemaConversionError synchronously for an unrepresentable schema, with no generic-object fallback', () => {
    expect(() => toOutputJsonSchema(z.date())).toThrow(OutputSchemaConversionError);
    try {
      toOutputJsonSchema(z.date());
      throw new Error('expected toOutputJsonSchema to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OutputSchemaConversionError);
      expect((error as InstanceType<typeof OutputSchemaConversionError>).code).toBe(
        'OUTPUT_SCHEMA_CONVERSION_FAILED',
      );
      expect((error as InstanceType<typeof OutputSchemaConversionError>).cause).toBeDefined();
    }
  });

  it('memoizes by schema identity — repeated calls on the same schema return the same object', () => {
    const schema = z.object({ answer: z.string() });
    const first = toOutputJsonSchema(schema);
    const second = toOutputJsonSchema(schema);
    expect(second).toBe(first);
  });

  it('does not cross-contaminate two structurally-identical but distinct schema instances', () => {
    const a = z.object({ answer: z.string() });
    const b = z.object({ answer: z.string() });
    expect(toOutputJsonSchema(a)).toEqual(toOutputJsonSchema(b));
    expect(toOutputJsonSchema(a)).not.toBe(toOutputJsonSchema(b));
  });

  it('keeps throwing for an unrepresentable schema on every call, not just the first', () => {
    const schema = z.date();
    expect(() => toOutputJsonSchema(schema)).toThrow(OutputSchemaConversionError);
    expect(() => toOutputJsonSchema(schema)).toThrow(OutputSchemaConversionError);
  });
});
