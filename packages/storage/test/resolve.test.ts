import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'bun:test';

import type { KeyValueStore } from '../src/types';

describe('resolveKeyValueStore', () => {
  const resolveAdapterOverrideSymbol = Symbol.for('agent-bureau.storage.resolve.adapters');
  let store: KeyValueStore | undefined;
  const originalChrome: unknown = (globalThis as Record<string, unknown>).chrome;
  const originalFetch: typeof fetch | undefined = globalThis.fetch;

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
    };
  }

  function installMockChrome() {
    const local = createMockChromeStorageArea();
    const session = createMockChromeStorageArea();
    (globalThis as Record<string, unknown>).chrome = {
      storage: { local, session },
    };
  }

  function removeMockChrome() {
    if (originalChrome === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
      return;
    }

    (globalThis as Record<string, unknown>).chrome = originalChrome;
  }

  function installResolveAdapterOverride(resolveAdapterOverride: Record<string, unknown>): void {
    (globalThis as Record<PropertyKey, unknown>)[resolveAdapterOverrideSymbol] =
      resolveAdapterOverride;
  }

  afterEach(async () => {
    if (store?.close) {
      await store.close();
    }
    store = undefined;
    delete (globalThis as Record<PropertyKey, unknown>)[resolveAdapterOverrideSymbol];
    removeMockChrome();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  describe('explicit configuration', () => {
    it('returns a working memory adapter for { type: "memory" }', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'memory' });

      await store.set('probe', 'value');
      expect(await store.get('probe')).toBe('value');
      await store.delete('probe');
      expect(await store.get('probe')).toBeNull();
    });

    it('memory adapter supports full CRUD round-trip', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'memory' });

      await store.set('test:key', 'hello');
      expect(await store.get('test:key')).toBe('hello');

      await store.set('test:key', 'updated');
      expect(await store.get('test:key')).toBe('updated');

      await store.set('test:other', 'world');
      const keys = await store.list('test:');
      expect(keys).toContain('test:key');
      expect(keys).toContain('test:other');

      await store.delete('test:key');
      expect(await store.get('test:key')).toBeNull();
    });

    it('returns a working SQLite adapter for { type: "sqlite", path: ":memory:" }', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'sqlite', path: ':memory:' });

      await store.set('probe', 'value');
      expect(await store.get('probe')).toBe('value');
    });

    it('SQLite adapter supports full CRUD round-trip', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'sqlite', path: ':memory:' });

      await store.set('agent:name', 'bureau');
      expect(await store.get('agent:name')).toBe('bureau');

      await store.set('agent:version', '1.0');
      const keys = await store.list('agent:');
      expect(keys).toContain('agent:name');
      expect(keys).toContain('agent:version');

      await store.delete('agent:name');
      expect(await store.get('agent:name')).toBeNull();
    });

    it('returns a working IndexedDB adapter for indexeddb configuration', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({
        type: 'indexeddb',
        databaseName: `resolve-indexeddb-${crypto.randomUUID()}`,
      });

      await store.set('probe', 'indexeddb');
      expect(await store.get('probe')).toBe('indexeddb');
    });

    it('returns a working chrome storage adapter for chrome-storage configuration', async () => {
      installMockChrome();
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'chrome-storage', area: 'session' });

      await store.set('probe', 'chrome');
      expect(await store.get('probe')).toBe('chrome');
    });

    it('returns a working remote adapter for remote configuration', async () => {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/kv/probe') && init?.method === 'PUT') {
          return new Response('', { status: 200 });
        }
        if (url.endsWith('/kv/probe') && init?.method === 'GET') {
          return new Response('remote', { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url} ${init?.method}`);
      };

      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'remote', baseUrl: 'https://example.test' });

      await store.set('probe', 'remote');
      expect(await store.get('probe')).toBe('remote');
    });

    it('uses the remote override when one is installed', async () => {
      const remoteStore = {
        get: async (key: string) => (key === 'probe' ? 'override-remote' : null),
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [] as string[],
      } satisfies KeyValueStore;

      installResolveAdapterOverride({
        createRemoteKeyValueStore: () => remoteStore,
      });

      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'remote', baseUrl: 'https://example.test' });

      expect(await store.get('probe')).toBe('override-remote');
    });
  });

  describe('auto-detection', () => {
    it('selects SQLite in Bun environment', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      const { isSQLiteAvailable } = await import('../src/adapters/sqlite-adapter');
      store = await resolveKeyValueStore({ type: 'auto' });

      // In Bun, SQLite should be selected; verify it works and SQLite is available
      await store.set('probe', '1');
      expect(await store.get('probe')).toBe('1');
      expect(isSQLiteAvailable()).toBe(true);
    });

    it('auto-detected adapter is functional', async () => {
      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      await store.set('auto:test', 'value');
      expect(await store.get('auto:test')).toBe('value');

      await store.delete('auto:test');
      expect(await store.get('auto:test')).toBeNull();
    });

    it('falls back to chrome storage when SQLite is unavailable', async () => {
      const chromeStore = {
        get: async (key: string) => (key === 'probe' ? 'chrome' : null),
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [] as string[],
      } satisfies KeyValueStore;

      installResolveAdapterOverride({
        isSQLiteAvailable: () => false,
        isChromeStorageAvailable: () => true,
        createChromeKeyValueStore: () => chromeStore,
      });

      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      expect(await store.get('probe')).toBe('chrome');
    });

    it('falls back to IndexedDB when SQLite and chrome storage are unavailable', async () => {
      const indexedDBStore = {
        get: async (key: string) => (key === 'probe' ? 'indexeddb' : null),
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [] as string[],
      } satisfies KeyValueStore;

      installResolveAdapterOverride({
        isSQLiteAvailable: () => false,
        isChromeStorageAvailable: () => false,
        isIndexedDBAvailable: () => true,
        createIndexedDBKeyValueStore: () => indexedDBStore,
      });

      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      expect(await store.get('probe')).toBe('indexeddb');
    });

    it('falls back to memory when no platform adapter is available', async () => {
      const memoryStore = {
        get: async (key: string) => (key === 'probe' ? 'memory' : null),
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [] as string[],
      } satisfies KeyValueStore;

      installResolveAdapterOverride({
        isSQLiteAvailable: () => false,
        isChromeStorageAvailable: () => false,
        isIndexedDBAvailable: () => false,
        createMemoryKeyValueStore: () => memoryStore,
      });

      const { resolveKeyValueStore } = await import('../src/resolve');
      store = await resolveKeyValueStore({ type: 'auto' });

      expect(await store.get('probe')).toBe('memory');
    });
  });
});
