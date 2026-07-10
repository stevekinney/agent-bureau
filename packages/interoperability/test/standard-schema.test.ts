import { describe, expect, test } from 'bun:test';

import {
  isStandardSchema,
  type StandardSchemaV1,
  validateStandardSchema,
} from '../src/standard-schema';

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function positiveIntegerSchema(): StandardSchemaV1<unknown, number> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          return { value };
        }
        return { issues: [{ message: 'expected a positive integer' }] };
      },
    },
  };
}

/** A validator whose `validate` resolves asynchronously, per the spec's allowance. */
function asyncEchoSchema(): StandardSchemaV1<unknown, string> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test-async',
      async validate(value: unknown) {
        await Promise.resolve();
        if (typeof value === 'string') {
          return { value };
        }
        return { issues: [{ message: 'expected a string', path: [{ key: 'value' }] }] };
      },
    },
  };
}

describe('isStandardSchema', () => {
  test('recognizes a validator with a `~standard.validate` function', () => {
    expect(isStandardSchema(positiveIntegerSchema())).toBe(true);
  });

  test('rejects plain objects without `~standard`', () => {
    expect(isStandardSchema({ type: 'object' })).toBe(false);
  });

  test('rejects primitives', () => {
    expect(isStandardSchema('not a schema')).toBe(false);
    expect(isStandardSchema(42)).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema(undefined)).toBe(false);
  });

  test('rejects an object whose `~standard` has no validate function', () => {
    expect(isStandardSchema({ '~standard': { version: 1 } })).toBe(false);
  });
});

describe('validateStandardSchema', () => {
  test('resolves the success result for a valid value', async () => {
    const result = await validateStandardSchema(positiveIntegerSchema(), 5);
    expect(result.issues).toBeUndefined();
    if (result.issues !== undefined) throw new Error('expected a success result');
    expect(result.value).toBe(5);
  });

  test('resolves the failure result for an invalid value', async () => {
    const result = await validateStandardSchema(positiveIntegerSchema(), -1);
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.message).toBe('expected a positive integer');
  });

  test('awaits a validator whose `validate` returns a promise', async () => {
    const result = await validateStandardSchema(asyncEchoSchema(), 'hello');
    expect(result.issues).toBeUndefined();
    if (result.issues !== undefined) throw new Error('expected a success result');
    expect(result.value).toBe('hello');
  });

  test('awaits a rejecting async validator and surfaces its issue path', async () => {
    const result = await validateStandardSchema(asyncEchoSchema(), 42);
    expect(result.issues?.[0]?.path?.[0]).toEqual({ key: 'value' });
  });
});
