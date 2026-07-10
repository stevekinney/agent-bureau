import { describe, expect, it } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { normalizeSchema } from '../src/utilities/schema-normalization';

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function nonEmptyStringSchema(): StandardSchemaV1<unknown, string> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (typeof value === 'string' && value.length > 0) {
          return { value };
        }
        return { issues: [{ message: 'expected a non-empty string' }] };
      },
    },
  };
}

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

  it('wraps a non-Zod Standard Schema validator into a ZodTypeAny', async () => {
    const result = normalizeSchema(nonEmptyStringSchema());
    await expect(result.parseAsync('ok')).resolves.toBe('ok');
    try {
      await result.parseAsync('');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
    }
  });

  it('is idempotent for an already-wrapped Standard Schema (re-normalization passes through)', async () => {
    // A `Tool` built by `createTool` stores the WRAPPED schema on
    // `tool.configuration.input`. Re-registering that tool through
    // `createToolbox([tool])` re-runs `normalizeSchema` on the already-wrapped
    // pipe. Before the fix this hit the "non-object Zod schema" branch and
    // threw "Tool input must be a Zod object schema" — see
    // `create-toolbox-standard-schema.test.ts` for the end-to-end regression.
    const wrapped = normalizeSchema(nonEmptyStringSchema());
    const reNormalized = normalizeSchema(wrapped);
    expect(reNormalized).toBe(wrapped);
    await expect(reNormalized.parseAsync('ok')).resolves.toBe('ok');
  });
});
