import { describe, expect, test } from 'bun:test';

import { isCanonicalToolResultPayload, parseJSONValue, toJSONValue } from '../src/adapters/shared';

describe('shared adapter helpers', () => {
  describe('toJSONValue', () => {
    test('returns primitives as-is', () => {
      expect(toJSONValue(null)).toBeNull();
      expect(toJSONValue('hello')).toBe('hello');
      expect(toJSONValue(42)).toBe(42);
      expect(toJSONValue(true)).toBe(true);
    });

    test('converts arrays recursively', () => {
      expect(toJSONValue([1, 'a', null])).toEqual([1, 'a', null]);
    });

    test('converts objects recursively', () => {
      expect(toJSONValue({ a: 1, b: 'c' })).toEqual({ a: 1, b: 'c' });
    });

    test('converts undefined to string fallback', () => {
      expect(toJSONValue(undefined)).toBe('undefined');
    });
  });

  describe('parseJSONValue', () => {
    test('parses valid JSON', () => {
      expect(parseJSONValue('{"a":1}')).toEqual({ a: 1 });
    });

    test('returns undefined for invalid JSON', () => {
      expect(parseJSONValue('not json')).toBeUndefined();
    });
  });

  describe('isCanonicalToolResultPayload', () => {
    test('returns true for valid canonical payload', () => {
      expect(
        isCanonicalToolResultPayload({
          outcome: 'success',
          content: 'data',
        }),
      ).toBe(true);
    });

    test('returns false for non-object', () => {
      expect(isCanonicalToolResultPayload('string')).toBe(false);
      expect(isCanonicalToolResultPayload(null)).toBe(false);
    });

    test('returns false when missing outcome', () => {
      expect(isCanonicalToolResultPayload({ content: 'data' })).toBe(false);
    });

    test('returns false when missing content', () => {
      expect(isCanonicalToolResultPayload({ outcome: 'success' })).toBe(false);
    });
  });
});
