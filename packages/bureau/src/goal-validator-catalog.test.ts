/**
 * COR-851 — the serializable validator catalog: exact `(name, version)`
 * resolution that never falls back, and descriptors that survive a JSON
 * round trip.
 */
import type { Validator } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import {
  createGoalValidatorCatalog,
  decodeGoalValidatorDescriptor,
} from './goal-validator-catalog';

function validator(
  name: string,
  version: string,
  determinism?: 'deterministic' | 'stochastic',
): Validator {
  return {
    identity: { name, version },
    ...(determinism === undefined ? {} : { determinism }),
    validate: () => ({ kind: 'pass', evidence: [] }),
  };
}

describe('createGoalValidatorCatalog resolution', () => {
  it('resolves the exact name and version to the registered validator', () => {
    const registered = validator('tests@bureau', '1.0.0', 'deterministic');
    const catalog = createGoalValidatorCatalog([registered]);

    const resolution = catalog.resolve({ name: 'tests@bureau', version: '1.0.0' });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('unreachable');
    expect(resolution.entry.validator).toBe(registered);
    expect(resolution.entry.identity).toEqual({ name: 'tests@bureau', version: '1.0.0' });
    expect(catalog.has({ name: 'tests@bureau', version: '1.0.0' })).toBe(true);
  });

  it('reports a name nobody registered as missing, with no versions to offer', () => {
    const catalog = createGoalValidatorCatalog([validator('tests@bureau', '1.0.0')]);

    expect(catalog.resolve({ name: 'lint@bureau', version: '1.0.0' })).toEqual({
      ok: false,
      reason: 'missing',
      requested: { name: 'lint@bureau', version: '1.0.0' },
      availableVersions: [],
    });
    expect(catalog.has({ name: 'lint@bureau', version: '1.0.0' })).toBe(false);
  });

  it('reports a version mismatch and never falls back to another version', () => {
    const catalog = createGoalValidatorCatalog([
      validator('tests@bureau', '1.0.0'),
      validator('tests@bureau', '2.0.0'),
    ]);

    const resolution = catalog.resolve({ name: 'tests@bureau', version: '1.5.0' });

    expect(resolution).toEqual({
      ok: false,
      reason: 'version-mismatch',
      requested: { name: 'tests@bureau', version: '1.5.0' },
      availableVersions: ['1.0.0', '2.0.0'],
    });
  });

  it('resolves two versions of one name independently', () => {
    const first = validator('tests@bureau', '1.0.0');
    const second = validator('tests@bureau', '2.0.0');
    const catalog = createGoalValidatorCatalog([first, second]);

    const one = catalog.resolve({ name: 'tests@bureau', version: '1.0.0' });
    const two = catalog.resolve({ name: 'tests@bureau', version: '2.0.0' });

    expect(one.ok && one.entry.validator).toBe(first);
    expect(two.ok && two.entry.validator).toBe(second);
  });

  it('treats runtime values that are not strings as missing instead of throwing', () => {
    const catalog = createGoalValidatorCatalog([validator('tests@bureau', '1.0.0')]);

    for (const identity of [
      { name: undefined, version: '1.0.0' },
      { name: 'tests@bureau', version: 1 },
      { name: {}, version: null },
    ]) {
      const resolution = catalog.resolve(identity);
      expect(resolution.ok).toBe(false);
    }
    expect(catalog.resolve({ name: 7, version: 7 })).toMatchObject({
      reason: 'missing',
      requested: { name: '', version: '' },
    });
  });

  it('does not match inherited object keys as validator names', () => {
    const catalog = createGoalValidatorCatalog([validator('tests@bureau', '1.0.0')]);

    expect(catalog.resolve({ name: 'constructor', version: '1.0.0' })).toMatchObject({
      reason: 'missing',
    });
    expect(catalog.resolve({ name: '__proto__', version: 'toString' })).toMatchObject({
      reason: 'missing',
    });
  });

  it('is empty by default', () => {
    const catalog = createGoalValidatorCatalog();

    expect(catalog.entries()).toEqual([]);
    expect(catalog.descriptors()).toEqual([]);
  });
});

describe('createGoalValidatorCatalog construction', () => {
  it('refuses two validators registered under the same name and version', () => {
    expect(() =>
      createGoalValidatorCatalog([
        validator('tests@bureau', '1.0.0'),
        validator('tests@bureau', '1.0.0'),
      ]),
    ).toThrow('registered more than once');
  });

  it('refuses a validator without a usable identity or validate function', () => {
    const noVersion = {
      identity: { name: 'a', version: '' },
      validate: () => ({ kind: 'canceled' }),
    };
    const noIdentity = { validate: () => ({ kind: 'canceled' }) };
    const noValidate = { identity: { name: 'a', version: '1' } };

    for (const broken of [noVersion, noIdentity, noValidate]) {
      expect(() => createGoalValidatorCatalog([broken as unknown as Validator])).toThrow(TypeError);
    }
  });

  it('freezes the catalog, its entries, and their descriptors', () => {
    const catalog = createGoalValidatorCatalog([validator('tests@bureau', '1.0.0')]);
    const [entry] = catalog.entries();
    if (entry === undefined) throw new Error('expected an entry');

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.descriptor)).toBe(true);
    expect(Object.isFrozen(entry.identity)).toBe(true);
    expect(() => {
      (entry as { identity: unknown }).identity = { name: 'other', version: '9' };
    }).toThrow();
  });

  it('hands out a copy of the entry list, so a caller cannot desynchronize the catalog', () => {
    const catalog = createGoalValidatorCatalog([validator('tests@bureau', '1.0.0')]);

    catalog.entries().pop();

    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.has({ name: 'tests@bureau', version: '1.0.0' })).toBe(true);
  });

  it('keeps registration order in descriptors', () => {
    const catalog = createGoalValidatorCatalog([
      validator('b@bureau', '1.0.0'),
      validator('a@bureau', '1.0.0'),
    ]);

    expect(catalog.descriptors().map((descriptor) => descriptor.identity.name)).toEqual([
      'b@bureau',
      'a@bureau',
    ]);
  });
});

describe('goal validator descriptors', () => {
  it('records the declared determinism and survives a JSON round trip', () => {
    const catalog = createGoalValidatorCatalog([
      validator('tests@bureau', '1.0.0', 'deterministic'),
      validator('judge@bureau', '1.0.0', 'stochastic'),
      validator('plain@bureau', '1.0.0'),
    ]);

    const descriptors = catalog.descriptors();

    expect(descriptors.map((descriptor) => descriptor.determinism)).toEqual([
      'deterministic',
      'stochastic',
      undefined,
    ]);
    for (const descriptor of descriptors) {
      const decoded = decodeGoalValidatorDescriptor(JSON.parse(JSON.stringify(descriptor)));
      expect(decoded).toEqual(descriptor);
    }
  });

  it('gives descriptors that differ only by determinism different digests', () => {
    const catalog = createGoalValidatorCatalog([
      validator('tests@bureau', '1.0.0', 'deterministic'),
      validator('tests@bureau', '2.0.0', 'stochastic'),
    ]);
    const [first, second] = catalog.descriptors();

    expect(first?.descriptorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.descriptorDigest).not.toBe(second?.descriptorDigest);
    expect(
      createGoalValidatorCatalog([
        validator('tests@bureau', '1.0.0', 'deterministic'),
      ]).descriptors()[0]?.descriptorDigest,
    ).toBe(first?.descriptorDigest);
  });

  it('decodes fail-closed: tampering, extra keys, and the wrong shape are refused', () => {
    const [descriptor] = createGoalValidatorCatalog([
      validator('tests@bureau', '1.0.0', 'deterministic'),
    ]).descriptors();
    if (descriptor === undefined) throw new Error('expected a descriptor');
    const json = JSON.parse(JSON.stringify(descriptor)) as Record<string, unknown>;

    const refused = [
      { ...json, determinism: 'stochastic' },
      { ...json, descriptorDigest: 'f'.repeat(64) },
      { ...json, extra: true },
      { ...json, identity: { name: 'tests@bureau' } },
      { ...json, identity: null },
      { ...json, determinism: 'maybe' },
      null,
      [],
      'text',
    ];

    for (const candidate of refused) {
      expect(decodeGoalValidatorDescriptor(candidate)).toBeUndefined();
    }
  });
});
