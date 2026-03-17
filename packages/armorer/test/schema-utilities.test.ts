import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  getSchemaKeys,
  getSchemaShape,
  isZodObjectSchema,
  isZodSchema,
  schemasLooselyMatch,
  unwrapSchema,
} from '../src/schema-utilities';

describe('schema utilities', () => {
  it('derives shapes from direct shape functions and objects', () => {
    const fnShape = { shape: () => ({ foo: 1, bar: 2 }) };
    const objShape = { shape: { baz: true } };
    const defShape = { _def: { shape: () => ({ qux: 'ok' }) } };

    expect(getSchemaShape(fnShape as any)).toEqual({ foo: 1, bar: 2 });
    expect(getSchemaShape(objShape as any)).toEqual({ baz: true });
    expect(getSchemaShape(defShape as any)).toEqual({ qux: 'ok' });
  });

  it('gracefully handles shape accessors that throw', () => {
    const throwingShape = {
      shape: () => {
        throw new Error('nope');
      },
    };
    const throwingDefShape = {
      _def: {
        shape: () => {
          throw new Error('boom');
        },
      },
    };

    expect(getSchemaShape(throwingShape as any)).toBeUndefined();
    expect(getSchemaShape(throwingDefShape as any)).toBeUndefined();
  });

  it('unwraps nested schema wrappers', () => {
    const leaf = { shape: () => ({ leaf: true }) };
    const viaInner = { _def: { innerType: leaf } };
    const viaSchema = { _def: { schema: leaf } };
    const viaDefOut = { def: { out: leaf } };

    expect(unwrapSchema(viaInner as any)).toBe(leaf);
    expect(unwrapSchema(viaSchema as any)).toBe(leaf);
    expect(unwrapSchema(viaDefOut as any)).toBe(leaf);
  });

  it('returns schema keys when shape information exists', () => {
    const schema = { shape: () => ({ alpha: true, beta: true }) };
    expect(getSchemaKeys(schema as any).sort()).toEqual(['alpha', 'beta']);
    expect(getSchemaKeys({} as any)).toEqual([]);
  });

  it('performs loose schema comparison with subset semantics', () => {
    const target = { shape: () => ({ foo: true, bar: true }) };
    const matching = { shape: () => ({ foo: true }) };
    const nonMatching = { shape: () => ({ baz: true }) };
    const empty = { shape: () => ({}) };

    expect(schemasLooselyMatch(target as any, matching as any)).toBe(true);
    expect(schemasLooselyMatch(target as any, nonMatching as any)).toBe(false);
    expect(schemasLooselyMatch(target as any, empty as any)).toBe(true);
    expect(schemasLooselyMatch({} as any, matching as any)).toBe(false);
  });

  it('identifies Zod schemas via safeParse detection', () => {
    expect(
      isZodSchema({
        safeParse() {
          return null;
        },
      }),
    ).toBe(true);
    expect(isZodSchema(null)).toBe(false);
  });

  it('identifies Zod object schemas by shape detection', () => {
    expect(isZodObjectSchema(z.object({ foo: z.string() }))).toBe(true);
    expect(isZodObjectSchema(z.number())).toBe(false);
  });
});
