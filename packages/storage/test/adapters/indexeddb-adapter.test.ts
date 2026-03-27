import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  createIndexedDBKeyValueStore,
  isIndexedDBAvailable,
} from '../../src/adapters/indexeddb-adapter';
import type { KeyValueStore } from '../../src/types';

describe('createIndexedDBKeyValueStore', () => {
  let store: KeyValueStore;

  beforeEach(async () => {
    store = await createIndexedDBKeyValueStore({
      databaseName: `test-${crypto.randomUUID()}`,
    });
  });

  afterEach(async () => {
    await store.close?.();
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
    it('close resolves without error', async () => {
      await expect(store.close!()).resolves.toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('uses custom database and store names', async () => {
      const customStore = await createIndexedDBKeyValueStore({
        databaseName: `custom-db-${crypto.randomUUID()}`,
        storeName: 'custom-store',
      });

      await customStore.set('key', 'value');
      expect(await customStore.get('key')).toBe('value');
      await customStore.close?.();
    });

    it('uses default database and store names', async () => {
      // Should not throw when using defaults
      const defaultStore = await createIndexedDBKeyValueStore();
      await defaultStore.set('key', 'value');
      expect(await defaultStore.get('key')).toBe('value');
      await defaultStore.close?.();
    });
  });

  describe('namespace support', () => {
    it('isolates keys with namespace', async () => {
      const dbName = `ns-test-${crypto.randomUUID()}`;
      const storeA = await createIndexedDBKeyValueStore({
        databaseName: dbName,
        namespace: 'alpha',
      });
      const storeB = await createIndexedDBKeyValueStore({
        databaseName: dbName,
        namespace: 'beta',
      });

      await storeA.set('key', 'from-alpha');
      await storeB.set('key', 'from-beta');

      expect(await storeA.get('key')).toBe('from-alpha');
      expect(await storeB.get('key')).toBe('from-beta');

      await storeA.close?.();
      await storeB.close?.();
    });
  });
});

describe('isIndexedDBAvailable', () => {
  it('returns true when indexedDB is available', () => {
    // fake-indexeddb/auto sets globalThis.indexedDB
    expect(isIndexedDBAvailable()).toBe(true);
  });
});
