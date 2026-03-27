import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  createChromeKeyValueStore,
  isChromeStorageAvailable,
} from '../../src/adapters/chrome-storage-adapter';
import type { KeyValueStore } from '../../src/types';

/**
 * Creates a mock chrome.storage area backed by an in-memory Map.
 * Simulates the Chrome Storage API surface used by the adapter.
 */
function createMockChromeStorageArea() {
  const data = new Map<string, unknown>();

  return {
    get(keys: string | null): Promise<Record<string, unknown>> {
      if (keys === null) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of data) {
          result[key] = value;
        }
        return Promise.resolve(result);
      }
      const result: Record<string, unknown> = {};
      const value = data.get(keys);
      if (value !== undefined) {
        result[keys] = value;
      }
      return Promise.resolve(result);
    },

    set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
      return Promise.resolve();
    },

    remove(keys: string | string[]): Promise<void> {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        data.delete(key);
      }
      return Promise.resolve();
    },

    /** Expose the underlying data for test assertions. */
    _data: data,
  };
}

function installMockChrome() {
  const local = createMockChromeStorageArea();
  const session = createMockChromeStorageArea();

  (globalThis as Record<string, unknown>).chrome = {
    storage: { local, session },
  };

  return { local, session };
}

function removeMockChrome() {
  delete (globalThis as Record<string, unknown>).chrome;
}

describe('createChromeKeyValueStore', () => {
  let store: KeyValueStore;

  beforeEach(() => {
    installMockChrome();
    store = createChromeKeyValueStore();
  });

  afterEach(() => {
    removeMockChrome();
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

  describe('storage area selection', () => {
    it('defaults to local storage area', async () => {
      const localStore = createChromeKeyValueStore();
      await localStore.set('key', 'local-value');
      expect(await localStore.get('key')).toBe('local-value');
    });

    it('uses session storage area when specified', async () => {
      const sessionStore = createChromeKeyValueStore({ area: 'session' });
      await sessionStore.set('key', 'session-value');
      expect(await sessionStore.get('key')).toBe('session-value');
    });

    it('local and session areas are isolated', async () => {
      const localStore = createChromeKeyValueStore({ area: 'local' });
      const sessionStore = createChromeKeyValueStore({ area: 'session' });

      await localStore.set('key', 'from-local');
      await sessionStore.set('key', 'from-session');

      expect(await localStore.get('key')).toBe('from-local');
      expect(await sessionStore.get('key')).toBe('from-session');
    });
  });

  describe('namespace support', () => {
    it('isolates keys with namespace', async () => {
      const storeA = createChromeKeyValueStore({ namespace: 'alpha' });
      const storeB = createChromeKeyValueStore({ namespace: 'beta' });

      await storeA.set('key', 'from-alpha');
      await storeB.set('key', 'from-beta');

      expect(await storeA.get('key')).toBe('from-alpha');
      expect(await storeB.get('key')).toBe('from-beta');
    });
  });
});

describe('isChromeStorageAvailable', () => {
  afterEach(() => {
    removeMockChrome();
  });

  it('returns true when chrome.storage is available', () => {
    installMockChrome();
    expect(isChromeStorageAvailable()).toBe(true);
  });

  it('returns false when chrome is not defined', () => {
    removeMockChrome();
    expect(isChromeStorageAvailable()).toBe(false);
  });
});
