import { describe, expect, test } from 'bun:test';

import { hasOwnProperty, toReadonly } from '../../src/utilities/type-helpers';

describe('type helpers', () => {
  describe('hasOwnProperty', () => {
    test('acts as a proper type guard', () => {
      const obj: Record<string, unknown> = { foo: 1 };

      if (hasOwnProperty(obj, 'foo')) {
        expect(obj.foo).toBe(1);
      } else {
        throw new Error('expected foo to exist');
      }

      expect(hasOwnProperty(obj, 'missing')).toBe(false);
    });

    test('returns false for inherited properties', () => {
      const obj = { own: true };
      expect(hasOwnProperty(obj, 'own')).toBe(true);
      expect(hasOwnProperty(obj, 'toString')).toBe(false);
    });
  });

  describe('toReadonly', () => {
    test('returns the same value', () => {
      const obj = { a: 1 };
      const readonly = toReadonly(obj);
      expect(readonly).toBe(obj);
    });
  });
});
