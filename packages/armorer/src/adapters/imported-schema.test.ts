import { describe, expect, it } from 'bun:test';

import { importToolSchema } from './imported-schema';

describe('importToolSchema', () => {
  it('falls back to unknown for non-object schemas', () => {
    const schema = importToolSchema('invalid');
    expect(schema.safeParse('anything').success).toBe(true);
  });

  it('supports const and enum literals', () => {
    const literalSchema = importToolSchema({ const: 'fixed' });
    const enumSchema = importToolSchema({ enum: ['a', 'b'] });

    expect(literalSchema.safeParse('fixed').success).toBe(true);
    expect(literalSchema.safeParse('other').success).toBe(false);
    expect(enumSchema.safeParse('a').success).toBe(true);
    expect(enumSchema.safeParse('c').success).toBe(false);
  });

  it('supports anyOf and oneOf unions', () => {
    const anyOfSchema = importToolSchema({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    const oneOfSchema = importToolSchema({
      oneOf: [{ type: 'boolean' }, { type: 'null' }],
    });

    expect(anyOfSchema.safeParse('value').success).toBe(true);
    expect(anyOfSchema.safeParse(42).success).toBe(true);
    expect(anyOfSchema.safeParse(false).success).toBe(false);
    expect(oneOfSchema.safeParse(true).success).toBe(true);
    expect(oneOfSchema.safeParse(null).success).toBe(true);
  });

  it('supports multi-type arrays and unknown type fallbacks', () => {
    const multiTypeSchema = importToolSchema({
      type: ['string', 'number'],
    });
    const unknownTypeSchema = importToolSchema({
      type: 'mystery',
    });

    expect(multiTypeSchema.safeParse('value').success).toBe(true);
    expect(multiTypeSchema.safeParse(42).success).toBe(true);
    expect(multiTypeSchema.safeParse(false).success).toBe(false);
    expect(unknownTypeSchema.safeParse({ anything: true }).success).toBe(true);
  });

  it('supports arrays, nullable values, defaults, and nested additionalProperties', () => {
    const schema = importToolSchema({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        state: {
          type: 'string',
          default: 'draft',
        },
        metadata: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        archived: {
          type: 'boolean',
          nullable: true,
        },
      },
      required: ['tags'],
      additionalProperties: true,
    });

    const parsed = schema.safeParse({
      tags: ['one'],
      metadata: { score: 1 },
      archived: null,
      extra: 'allowed',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { state?: string }).state).toBe('draft');
    }
    expect(schema.safeParse({ tags: ['one'], metadata: { score: 'bad' } }).success).toBe(false);
  });

  it('supports implicit object and array detection', () => {
    const objectSchema = importToolSchema({
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    });
    const arraySchema = importToolSchema({
      items: { type: 'integer' },
    });

    expect(objectSchema.safeParse({ query: 'armorer' }).success).toBe(true);
    expect(arraySchema.safeParse([1, 2, 3]).success).toBe(true);
    expect(arraySchema.safeParse(['bad']).success).toBe(false);
  });

  it('falls back to unknown schemas when no type information is available', () => {
    const schema = importToolSchema({});
    expect(schema.safeParse({ whatever: true }).success).toBe(true);
  });
});
