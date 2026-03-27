import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemoryKeyValueStore } from '../src/adapters/memory-adapter';
import type { KeyValueStore } from '../src/types';
import { withNamespace } from '../src/with-namespace';

describe('withNamespace', () => {
  let backing: KeyValueStore;
  let namespaced: KeyValueStore;

  beforeEach(() => {
    backing = createMemoryKeyValueStore();
    namespaced = withNamespace(backing, 'ns');
  });

  it('prefixes keys on set and strips on get', async () => {
    await namespaced.set('key', 'value');
    expect(await namespaced.get('key')).toBe('value');
    // Verify the actual key in the backing store
    expect(await backing.get('ns:key')).toBe('value');
  });

  it('get returns null for missing key', async () => {
    expect(await namespaced.get('missing')).toBeNull();
  });

  it('delete removes the prefixed key', async () => {
    await namespaced.set('key', 'value');
    await namespaced.delete('key');
    expect(await namespaced.get('key')).toBeNull();
    expect(await backing.get('ns:key')).toBeNull();
  });

  it('list returns keys without the namespace prefix', async () => {
    await namespaced.set('a', 'v');
    await namespaced.set('b', 'v');
    await backing.set('other:c', 'v');

    const keys = await namespaced.list('');
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).not.toContain('other:c');
  });

  it('list with a sub-prefix works correctly', async () => {
    await namespaced.set('skill:a', 'v');
    await namespaced.set('skill:b', 'v');
    await namespaced.set('identity:x', 'v');

    const keys = await namespaced.list('skill:');
    expect(keys).toEqual(['skill:a', 'skill:b']);
  });

  describe('isolation', () => {
    it('two wrappers with different namespaces on the same backing store are isolated', async () => {
      const storeA = withNamespace(backing, 'alpha');
      const storeB = withNamespace(backing, 'beta');

      await storeA.set('shared-key', 'from-alpha');
      await storeB.set('shared-key', 'from-beta');

      expect(await storeA.get('shared-key')).toBe('from-alpha');
      expect(await storeB.get('shared-key')).toBe('from-beta');
    });
  });

  describe('nested namespaces', () => {
    it('composes correctly', async () => {
      const inner = withNamespace(backing, 'inner');
      const outer = withNamespace(inner, 'outer');

      await outer.set('key', 'nested');

      // The actual key in backing should be inner:outer:key
      expect(await backing.get('inner:outer:key')).toBe('nested');
      expect(await outer.get('key')).toBe('nested');
    });
  });

  describe('optional method delegation', () => {
    it('delegates has when present on the underlying store', async () => {
      await namespaced.set('key', 'value');
      expect(namespaced.has).toBeDefined();
      expect(await namespaced.has!('key')).toBe(true);
      expect(await namespaced.has!('missing')).toBe(false);
    });

    it('delegates deletePrefix when present on the underlying store', async () => {
      await namespaced.set('skill:a', 'v');
      await namespaced.set('skill:b', 'v');
      await namespaced.set('other', 'v');

      expect(namespaced.deletePrefix).toBeDefined();
      const count = await namespaced.deletePrefix!('skill:');
      expect(count).toBe(2);
      expect(await namespaced.get('other')).toBe('v');
    });

    it('delegates close when present on the underlying store', async () => {
      expect(namespaced.close).toBeDefined();
      await expect(namespaced.close!()).resolves.toBeUndefined();
    });

    it('omits has when the underlying store does not have it', () => {
      const minimal: KeyValueStore = {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      };
      const wrapped = withNamespace(minimal, 'ns');
      expect(wrapped.has).toBeUndefined();
    });

    it('omits deletePrefix when the underlying store does not have it', () => {
      const minimal: KeyValueStore = {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      };
      const wrapped = withNamespace(minimal, 'ns');
      expect(wrapped.deletePrefix).toBeUndefined();
    });

    it('omits close when the underlying store does not have it', () => {
      const minimal: KeyValueStore = {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      };
      const wrapped = withNamespace(minimal, 'ns');
      expect(wrapped.close).toBeUndefined();
    });
  });
});
