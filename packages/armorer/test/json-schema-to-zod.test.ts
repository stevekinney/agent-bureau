import { describe, expect, it } from 'bun:test';

import {
  importToolSchema,
  internalJsonSchemaTestUtilities,
  jsonSchemaToZod,
} from '../src/utilities/json-schema-to-zod';

const { enumToZod } = internalJsonSchemaTestUtilities;

describe('jsonSchemaToZod', () => {
  it('returns undefined for non-object input', () => {
    expect(jsonSchemaToZod('string')).toBeUndefined();
    expect(jsonSchemaToZod(42)).toBeUndefined();
    expect(jsonSchemaToZod(null)).toBeUndefined();
    expect(jsonSchemaToZod(undefined)).toBeUndefined();
  });

  it('converts string type', () => {
    const schema = jsonSchemaToZod({ type: 'string' })!;
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it('converts number type', () => {
    const schema = jsonSchemaToZod({ type: 'number' })!;
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse('hello').success).toBe(false);
  });

  it('converts integer type', () => {
    const schema = jsonSchemaToZod({ type: 'integer' })!;
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(42.5).success).toBe(false);
  });

  it('converts boolean type', () => {
    const schema = jsonSchemaToZod({ type: 'boolean' })!;
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse('true').success).toBe(false);
  });

  it('converts null type', () => {
    const schema = jsonSchemaToZod({ type: 'null' })!;
    expect(schema.safeParse(null).success).toBe(true);
  });

  it('converts array type', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    })!;
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(schema.safeParse([1, 2]).success).toBe(false);
  });

  it('converts object type with properties and required', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    })!;
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true);
    expect(schema.safeParse({ name: 'Alice', age: 30 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // name is required
  });

  it('handles enum', () => {
    const schema = jsonSchemaToZod({ enum: ['a', 'b', 'c'] })!;
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse('d').success).toBe(false);
  });

  it('handles const', () => {
    const schema = jsonSchemaToZod({ const: 'fixed' })!;
    expect(schema.safeParse('fixed').success).toBe(true);
    expect(schema.safeParse('other').success).toBe(false);
  });

  it('handles anyOf', () => {
    const schema = jsonSchemaToZod({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    })!;
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it('handles oneOf', () => {
    const schema = jsonSchemaToZod({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    })!;
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
  });

  it('handles allOf', () => {
    const schema = jsonSchemaToZod({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    })!;
    expect(schema.safeParse({ a: 'hello', b: 42 }).success).toBe(true);
  });

  it('applies nullable', () => {
    const schema = jsonSchemaToZod({ type: 'string', nullable: true })!;
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse('hello').success).toBe(true);
  });

  it('applies description annotation', () => {
    const schema = jsonSchemaToZod({ type: 'string', description: 'A name' })!;
    expect(schema.description).toBe('A name');
  });

  it('applies default annotation', () => {
    const schema = jsonSchemaToZod({ type: 'string', default: 'hello' })!;
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('handles multi-type', () => {
    const schema = jsonSchemaToZod({ type: ['string', 'number'] })!;
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it('handles additionalProperties: false (strict)', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    })!;
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true);
    expect(schema.safeParse({ name: 'Alice', extra: true }).success).toBe(false);
  });

  it('infers object from properties without explicit type', () => {
    const schema = jsonSchemaToZod({
      properties: { x: { type: 'number' } },
      required: ['x'],
    })!;
    expect(schema.safeParse({ x: 42 }).success).toBe(true);
  });
});

describe('importToolSchema', () => {
  it('returns z.unknown() for non-record input', () => {
    const schema = importToolSchema('invalid');
    expect(schema.safeParse('anything').success).toBe(true);
  });

  it('converts a valid schema', () => {
    const schema = importToolSchema({ type: 'string' });
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });
});

describe('enumToZod', () => {
  it('returns z.never() for an empty values array', () => {
    const schema = enumToZod([]);
    expect(schema).toBeDefined();
    expect(schema!.safeParse('anything').success).toBe(false);
    expect(schema!.safeParse(undefined).success).toBe(false);
  });
});
