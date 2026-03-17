import { describe, expect, test } from 'bun:test';

import { sortMessagesByPosition, sortObjectKeys } from '../../src/sort';

describe('deterministic utilities', () => {
  describe('sortObjectKeys', () => {
    test('sorts object keys alphabetically', () => {
      const input = { z: 1, a: 2, m: 3 };
      const result = sortObjectKeys(input);
      expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
      expect(result).toEqual({ a: 2, m: 3, z: 1 });
    });

    test('recursively sorts nested objects', () => {
      const input = { b: { y: 1, x: 2 }, a: 1 };
      const result = sortObjectKeys(input);
      expect(Object.keys(result)).toEqual(['a', 'b']);
      expect(Object.keys(result.b)).toEqual(['x', 'y']);
    });

    test('handles arrays by processing elements but maintaining order', () => {
      const input = { items: [{ z: 1, a: 2 }, { b: 3 }] };
      const result = sortObjectKeys(input);
      expect(Object.keys(result.items[0])).toEqual(['a', 'z']);
      expect(result.items[0]).toEqual({ a: 2, z: 1 });
    });

    test('returns null as-is', () => {
      expect(sortObjectKeys(null)).toBe(null);
    });

    test('returns primitives as-is', () => {
      expect(sortObjectKeys(42)).toBe(42);
      expect(sortObjectKeys('string')).toBe('string');
      expect(sortObjectKeys(true)).toBe(true);
      expect(sortObjectKeys(undefined)).toBe(undefined);
    });

    test('handles empty objects', () => {
      const result = sortObjectKeys({});
      expect(result).toEqual({});
    });

    test('handles empty arrays', () => {
      const result = sortObjectKeys([]);
      expect(result).toEqual([]);
    });

    test('handles deeply nested structures', () => {
      const input = {
        c: {
          f: {
            i: { l: 1, k: 2 },
            h: 3,
          },
          e: 4,
        },
        b: 5,
        a: 6,
      };

      const result = sortObjectKeys(input);

      // Check top level
      expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
      // Check nested levels
      expect(Object.keys(result.c)).toEqual(['e', 'f']);
      expect(Object.keys(result.c.f)).toEqual(['h', 'i']);
      expect(Object.keys(result.c.f.i)).toEqual(['k', 'l']);
    });

    test('produces deterministic JSON.stringify output', () => {
      const obj1 = { z: 1, a: 2, m: 3 };
      const obj2 = { a: 2, z: 1, m: 3 };

      const sorted1 = sortObjectKeys(obj1);
      const sorted2 = sortObjectKeys(obj2);

      expect(JSON.stringify(sorted1)).toBe(JSON.stringify(sorted2));
    });
  });

  describe('sortMessagesByPosition', () => {
    test('sorts messages by position', () => {
      const messages = [
        { id: 'c', position: 2, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'b', position: 1, createdAt: '2024-01-15T10:00:00.000Z' },
      ];

      const result = sortMessagesByPosition(messages);

      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    test('uses createdAt as secondary sort when positions are equal', () => {
      const messages = [
        { id: 'b', position: 0, createdAt: '2024-01-15T10:01:00.000Z' },
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
      ];

      const result = sortMessagesByPosition(messages);

      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });

    test('uses id as tertiary sort when position and createdAt are equal', () => {
      const messages = [
        { id: 'c', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'b', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
      ];

      const result = sortMessagesByPosition(messages);

      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    test('does not mutate original array', () => {
      const messages = [
        { id: 'c', position: 2, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
      ];

      const original = [...messages];
      sortMessagesByPosition(messages);

      expect(messages).toEqual(original);
    });

    test('handles empty array', () => {
      const result = sortMessagesByPosition([]);
      expect(result).toEqual([]);
    });

    test('handles single element array', () => {
      const messages = [{ id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' }];

      const result = sortMessagesByPosition(messages);

      expect(result).toEqual(messages);
    });

    test('handles already sorted array', () => {
      const messages = [
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'b', position: 1, createdAt: '2024-01-15T10:01:00.000Z' },
        { id: 'c', position: 2, createdAt: '2024-01-15T10:02:00.000Z' },
      ];

      const result = sortMessagesByPosition(messages);

      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    test('works with readonly arrays', () => {
      const messages: readonly {
        id: string;
        position: number;
        createdAt: string;
      }[] = [
        { id: 'b', position: 1, createdAt: '2024-01-15T10:00:00.000Z' },
        { id: 'a', position: 0, createdAt: '2024-01-15T10:00:00.000Z' },
      ];

      const result = sortMessagesByPosition(messages);

      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });
});
