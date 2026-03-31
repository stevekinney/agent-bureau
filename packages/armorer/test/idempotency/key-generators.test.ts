import { describe, expect, it } from 'bun:test';

import {
  compositeKey,
  fieldKey,
  fullInputKey,
  namespacedKey,
} from '../../src/idempotency/key-generators';

describe('fullInputKey', () => {
  it('returns a 64-character sha256 hex hash', () => {
    const input = { a: 1, b: 'hello' };
    const result = fullInputKey(input);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash regardless of key order', () => {
    const input1 = { a: 1, b: 2 };
    const input2 = { b: 2, a: 1 };
    expect(fullInputKey(input1)).toBe(fullInputKey(input2));
  });

  it('handles nested objects with sorted keys', () => {
    const input1 = { outer: { z: 1, a: 2 } };
    const input2 = { outer: { a: 2, z: 1 } };
    expect(fullInputKey(input1)).toBe(fullInputKey(input2));
  });

  it('handles null input gracefully', () => {
    expect(() => fullInputKey(null)).not.toThrow();
    expect(typeof fullInputKey(null)).toBe('string');
  });

  it('handles undefined input gracefully', () => {
    expect(() => fullInputKey(undefined)).not.toThrow();
    expect(typeof fullInputKey(undefined)).toBe('string');
  });

  it('handles arrays deterministically', () => {
    const input = { items: [3, 1, 2] };
    const key1 = fullInputKey(input);
    const key2 = fullInputKey(input);
    expect(key1).toBe(key2);
  });

  it('handles empty objects', () => {
    expect(typeof fullInputKey({})).toBe('string');
    expect(fullInputKey({})).toHaveLength(64);
  });

  it('produces different hashes for different inputs', () => {
    expect(fullInputKey({ a: 1 })).not.toBe(fullInputKey({ a: 2 }));
  });
});

describe('fieldKey', () => {
  it('returns a function that hashes a single field value', () => {
    const keyFn = fieldKey('userId');
    const input = { userId: 'abc-123', query: 'irrelevant' };
    const result = keyFn(input);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same field value regardless of other fields', () => {
    const keyFn = fieldKey('userId');
    const input1 = { userId: 'abc', extra: 1 };
    const input2 = { userId: 'abc', extra: 2 };
    expect(keyFn(input1)).toBe(keyFn(input2));
  });

  it('uses empty string for undefined fields', () => {
    const keyFn = fieldKey('missing');
    const input = { other: 'value' };
    const result = keyFn(input);
    expect(result).toHaveLength(64);
  });

  it('uses empty string for null fields', () => {
    const keyFn = fieldKey('nullable');
    const input = { nullable: null };
    // Null and missing should produce the same key (both become empty string)
    const keyFnMissing = fieldKey('missing');
    expect(keyFn(input)).toBe(keyFnMissing({ other: 'x' }));
  });

  it('handles non-object input gracefully', () => {
    const keyFn = fieldKey('anything');
    expect(() => keyFn(42)).not.toThrow();
    expect(() => keyFn(null)).not.toThrow();
  });
});

describe('compositeKey', () => {
  it('hashes a combination of multiple field values', () => {
    const keyFn = compositeKey('userId', 'action');
    const input = { userId: 'abc', action: 'read', extra: 'ignored' };
    const result = keyFn(input);
    expect(result).toHaveLength(64);
  });

  it('produces different hashes when any component differs', () => {
    const keyFn = compositeKey('userId', 'action');
    const input1 = { userId: 'abc', action: 'read' };
    const input2 = { userId: 'abc', action: 'write' };
    expect(keyFn(input1)).not.toBe(keyFn(input2));
  });

  it('uses empty string for missing fields', () => {
    const keyFn = compositeKey('a', 'b', 'c');
    const input = { a: 'x', c: 'z' };
    expect(() => keyFn(input)).not.toThrow();
    expect(keyFn(input)).toHaveLength(64);
  });

  it('uses empty string for null fields', () => {
    const keyFn = compositeKey('a', 'b');
    const input = { a: null, b: 'y' };
    expect(() => keyFn(input)).not.toThrow();
  });

  it('handles non-object input gracefully', () => {
    const keyFn = compositeKey('a', 'b');
    expect(() => keyFn(null)).not.toThrow();
    expect(() => keyFn(undefined)).not.toThrow();
  });
});

describe('namespacedKey', () => {
  it('prefixes the key with the tool name', () => {
    const innerKey = fullInputKey;
    const keyFn = namespacedKey('my-tool', innerKey);
    const input = { a: 1 };
    const innerResult = innerKey(input);
    expect(keyFn(input)).toBe(`my-tool:${innerResult}`);
  });

  it('works with fieldKey as inner function', () => {
    const inner = fieldKey('id');
    const keyFn = namespacedKey('lookup', inner);
    const input = { id: '42' };
    expect(keyFn(input)).toBe(`lookup:${inner(input)}`);
  });

  it('works with compositeKey as inner function', () => {
    const inner = compositeKey('a', 'b');
    const keyFn = namespacedKey('combo', inner);
    const input = { a: 1, b: 2 };
    expect(keyFn(input)).toBe(`combo:${inner(input)}`);
  });
});
