import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { normalizeSchema } from '../src/utilities/schema-normalization';

describe('normalizeSchema', () => {
  it('returns z.object({}) for undefined input', () => {
    const result = normalizeSchema(undefined);
    expect(result).toBeDefined();
    const parsed = result.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('passes through a ZodObject schema unchanged', () => {
    const schema = z.object({ name: z.string() });
    const result = normalizeSchema(schema);
    expect(result).toBe(schema);
  });

  it('wraps a plain object of Zod schemas with z.object', () => {
    const shape = { name: z.string(), age: z.number() };
    const result = normalizeSchema(shape);
    const parsed = result.safeParse({ name: 'Alice', age: 30 });
    expect(parsed.success).toBe(true);
  });

  it('throws for a non-object Zod schema (e.g. z.string())', () => {
    expect(() => normalizeSchema(z.string())).toThrow('Tool input must be a Zod object schema');
  });

  it('throws for a non-object value like a string', () => {
    expect(() => normalizeSchema('not a schema')).toThrow(
      'Tool input must be a Zod object schema or an object of Zod schemas',
    );
  });

  it('throws for a number', () => {
    expect(() => normalizeSchema(42)).toThrow(
      'Tool input must be a Zod object schema or an object of Zod schemas',
    );
  });
});
