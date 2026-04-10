import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  createIndexedDBKeyValueStore,
  isIndexedDBAvailable,
} from '../../src/adapters/indexeddb-adapter';
import type { KeyValueStore } from '../../src/types';

describe('createIndexedDBKeyValueStore', () => {
  let store: KeyValueStore;
  const originalIndexedDB = globalThis.indexedDB;
  const originalIDBKeyRange = globalThis.IDBKeyRange;

  function restoreIndexedDBGlobals(): void {
    globalThis.indexedDB = originalIndexedDB;
    globalThis.IDBKeyRange = originalIDBKeyRange;
  }

  function createMockIDBRequest<T>({
    result,
    error,
    trigger = 'success',
  }: {
    result?: T;
    error?: Error;
    trigger?: 'success' | 'error';
  }): IDBRequest<T> {
    const request = {
      result,
      error: error ?? null,
      onsuccess: null,
      onerror: null,
    } as unknown as IDBRequest<T>;

    queueMicrotask(() => {
      if (trigger === 'error') {
        request.onerror?.(new Event('error'));
        return;
      }

      request.onsuccess?.(new Event('success'));
    });

    return request;
  }

  function installMockIndexedDBForFailure(options: {
    openFails?: boolean;
    openError?: Error;
    operation?: 'get' | 'put' | 'delete' | 'getAllKeys' | 'openCursor' | 'getKey';
    objectStoreExists?: boolean;
  }): void {
    const database = {
      objectStoreNames: {
        contains: () => options.objectStoreExists ?? true,
      },
      createObjectStore: () => undefined,
      transaction: () => ({
        objectStore: () => ({
          get: () =>
            createMockIDBRequest<string | undefined>({
              error: new Error('get failed'),
              trigger: options.operation === 'get' ? 'error' : 'success',
            }),
          put: () =>
            createMockIDBRequest<void>({
              error: new Error('set failed'),
              trigger: options.operation === 'put' ? 'error' : 'success',
            }),
          delete: () =>
            createMockIDBRequest<void>({
              error: new Error('delete failed'),
              trigger: options.operation === 'delete' ? 'error' : 'success',
            }),
          getAllKeys: () =>
            createMockIDBRequest<Array<string>>({
              result: [],
              error: new Error('list failed'),
              trigger: options.operation === 'getAllKeys' ? 'error' : 'success',
            }),
          openCursor: () =>
            createMockIDBRequest<IDBCursorWithValue | null>({
              result: null,
              error: new Error('cursor failed'),
              trigger: options.operation === 'openCursor' ? 'error' : 'success',
            }),
          getKey: () =>
            createMockIDBRequest<IDBValidKey | undefined>({
              result: undefined,
              error: new Error('has failed'),
              trigger: options.operation === 'getKey' ? 'error' : 'success',
            }),
        }),
      }),
      close: () => undefined,
    } as unknown as IDBDatabase;

    globalThis.IDBKeyRange = {
      bound: () => ({}) as IDBKeyRange,
    } as typeof IDBKeyRange;

    globalThis.indexedDB = {
      open: () => {
        const request = {
          result: database,
          error: options.openError ?? null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        } as unknown as IDBOpenDBRequest;

        queueMicrotask(() => {
          if (options.openFails || options.openError) {
            request.onerror?.(new Event('error'));
            return;
          }

          request.onupgradeneeded?.(new Event('upgradeneeded'));
          request.onsuccess?.(new Event('success'));
        });

        return request;
      },
    } as unknown as IDBFactory;
  }

  beforeEach(async () => {
    store = await createIndexedDBKeyValueStore({
      databaseName: `test-${crypto.randomUUID()}`,
    });
  });

  afterEach(async () => {
    await store.close?.();
    restoreIndexedDBGlobals();
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

    it('creates the object store during upgrade when it does not already exist', async () => {
      const createdStores: string[] = [];
      const database = {
        objectStoreNames: {
          contains: () => false,
        },
        createObjectStore: (storeName: string) => {
          createdStores.push(storeName);
          return {} as IDBObjectStore;
        },
        close: () => undefined,
      } as unknown as IDBDatabase;

      globalThis.indexedDB = {
        open: () => {
          const request = {
            result: database,
            error: null,
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null,
          } as unknown as IDBOpenDBRequest;

          queueMicrotask(() => {
            request.onupgradeneeded?.(new Event('upgradeneeded'));
            request.onsuccess?.(new Event('success'));
          });

          return request;
        },
      } as unknown as IDBFactory;

      const upgradedStore = await createIndexedDBKeyValueStore({
        databaseName: `upgrade-${crypto.randomUUID()}`,
        storeName: 'custom-store',
      });

      expect(createdStores).toEqual(['custom-store']);
      await upgradedStore.close?.();
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

  describe('error handling', () => {
    it('rejects when opening the database fails without an IndexedDB error object', async () => {
      installMockIndexedDBForFailure({ openFails: true });

      await expect(
        createIndexedDBKeyValueStore({ databaseName: `error-open-${crypto.randomUUID()}` }),
      ).rejects.toThrow('Unknown IndexedDB error');
    });

    it('rejects get when the request fails without an IndexedDB error object', async () => {
      installMockIndexedDBForFailure({ operation: 'get' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.get('key')).rejects.toThrow('get failed');
      await failingStore.close?.();
    });

    it('rejects set when the request fails', async () => {
      installMockIndexedDBForFailure({ operation: 'put' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.set('key', 'value')).rejects.toThrow('set failed');
      await failingStore.close?.();
    });

    it('rejects delete when the request fails', async () => {
      installMockIndexedDBForFailure({ operation: 'delete' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.delete('key')).rejects.toThrow('delete failed');
      await failingStore.close?.();
    });

    it('rejects list for empty prefix when getAllKeys fails', async () => {
      installMockIndexedDBForFailure({ operation: 'getAllKeys' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.list('')).rejects.toThrow('list failed');
      await failingStore.close?.();
    });

    it('rejects list for prefixed queries when cursor iteration fails', async () => {
      installMockIndexedDBForFailure({ operation: 'openCursor' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.list('skill:')).rejects.toThrow('cursor failed');
      await failingStore.close?.();
    });

    it('rejects has when getKey fails', async () => {
      installMockIndexedDBForFailure({ operation: 'getKey' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.has!('key')).rejects.toThrow('has failed');
      await failingStore.close?.();
    });

    it('rejects deletePrefix when cursor iteration fails', async () => {
      installMockIndexedDBForFailure({ operation: 'openCursor' });
      const failingStore = await createIndexedDBKeyValueStore();
      await expect(failingStore.deletePrefix!('skill:')).rejects.toThrow('cursor failed');
      await failingStore.close?.();
    });
  });
});

describe('isIndexedDBAvailable', () => {
  it('returns true when indexedDB is available', () => {
    // fake-indexeddb/auto sets globalThis.indexedDB
    expect(isIndexedDBAvailable()).toBe(true);
  });
});
