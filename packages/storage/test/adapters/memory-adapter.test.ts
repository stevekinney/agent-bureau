import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemoryKeyValueStore } from '../../src/adapters/memory-adapter';
import type { KeyValueStore } from '../../src/types';

describe('createMemoryKeyValueStore', () => {
  let store: KeyValueStore;

  beforeEach(() => {
    store = createMemoryKeyValueStore();
  });

  describe('basic CRUD', () => {
    it('set and get a value', async () => {
      await store.set('key', 'value');
      expect(await store.get('key')).toBe('value');
    });

    it('get returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull();
    });

    it('set overwrites existing value', async () => {
      await store.set('key', 'first');
      await store.set('key', 'second');
      expect(await store.get('key')).toBe('second');
    });

    it('delete removes a key', async () => {
      await store.set('key', 'value');
      await store.delete('key');
      expect(await store.get('key')).toBeNull();
    });

    it('delete on non-existent key is a no-op', async () => {
      await expect(store.delete('nonexistent')).resolves.toBeUndefined();
    });

    it('handles empty string values', async () => {
      await store.set('key', '');
      expect(await store.get('key')).toBe('');
    });

    it('handles keys with special characters', async () => {
      const key = 'identity:soul:orchestrator';
      await store.set(key, 'data');
      expect(await store.get(key)).toBe('data');
    });
  });

  describe('list', () => {
    it('returns matching keys with prefix', async () => {
      await store.set('skill:a:metadata', '{}');
      await store.set('skill:b:metadata', '{}');
      await store.set('identity:soul', '{}');

      const keys = await store.list('skill:');
      expect(keys).toEqual(['skill:a:metadata', 'skill:b:metadata']);
    });

    it('returns empty array when no keys match', async () => {
      await store.set('key', 'value');
      expect(await store.list('nonexistent:')).toEqual([]);
    });

    it('returns all keys with empty prefix', async () => {
      await store.set('b', 'v');
      await store.set('a', 'v');
      const keys = await store.list('');
      expect(keys).toEqual(['a', 'b']);
    });

    it('returns keys in sorted order', async () => {
      await store.set('c', 'v');
      await store.set('a', 'v');
      await store.set('b', 'v');
      expect(await store.list('')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('has', () => {
    it('returns true for existing keys', async () => {
      await store.set('key', 'value');
      expect(await store.has!('key')).toBe(true);
    });

    it('returns false for missing keys', async () => {
      expect(await store.has!('missing')).toBe(false);
    });
  });

  describe('deletePrefix', () => {
    it('removes all matching keys and returns count', async () => {
      await store.set('skill:a', 'v');
      await store.set('skill:b', 'v');
      await store.set('identity:x', 'v');

      const count = await store.deletePrefix!('skill:');
      expect(count).toBe(2);
      expect(await store.get('skill:a')).toBeNull();
      expect(await store.get('skill:b')).toBeNull();
      expect(await store.get('identity:x')).toBe('v');
    });

    it('returns 0 when no keys match', async () => {
      expect(await store.deletePrefix!('nonexistent:')).toBe(0);
    });
  });

  describe('close', () => {
    it('close is a no-op', async () => {
      await expect(store.close!()).resolves.toBeUndefined();
    });
  });

  describe('namespace prefixing', () => {
    it('keys are transparently prefixed', async () => {
      const namespaced = createMemoryKeyValueStore({ namespace: 'test' });
      await namespaced.set('key', 'value');
      expect(await namespaced.get('key')).toBe('value');
    });

    it('two stores with different namespaces are isolated', async () => {
      const backing = createMemoryKeyValueStore();
      const { withNamespace } = await import('../../src/with-namespace');
      const storeA = withNamespace(backing, 'a');
      const storeB = withNamespace(backing, 'b');

      await storeA.set('key', 'from-a');
      await storeB.set('key', 'from-b');

      expect(await storeA.get('key')).toBe('from-a');
      expect(await storeB.get('key')).toBe('from-b');
    });
  });
});
