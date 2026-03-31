import type { KeyValueStore, KeyValueStoreConfiguration } from './types';

type ResolveAdapterOverride = {
  createMemoryKeyValueStore?: (() => KeyValueStore | Promise<KeyValueStore>) | undefined;
  createSQLiteKeyValueStore?:
    | ((options: { filename: string }) => KeyValueStore | Promise<KeyValueStore>)
    | undefined;
  isSQLiteAvailable?: (() => boolean) | undefined;
  createIndexedDBKeyValueStore?:
    | ((options?: { databaseName?: string }) => KeyValueStore | Promise<KeyValueStore>)
    | undefined;
  isIndexedDBAvailable?: (() => boolean) | undefined;
  createChromeKeyValueStore?:
    | ((options?: { area?: 'local' | 'session' }) => KeyValueStore | Promise<KeyValueStore>)
    | undefined;
  isChromeStorageAvailable?: (() => boolean) | undefined;
  createRemoteKeyValueStore?:
    | ((options: {
        baseUrl: string;
        headers?: Record<string, string>;
      }) => KeyValueStore | Promise<KeyValueStore>)
    | undefined;
};

const resolveAdapterOverrideSymbol = Symbol.for('agent-bureau.storage.resolve.adapters');

function getResolveAdapterOverride(): ResolveAdapterOverride | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[resolveAdapterOverrideSymbol] as
    | ResolveAdapterOverride
    | undefined;
}

async function getMemoryAdapter() {
  const resolveAdapterOverride = getResolveAdapterOverride();
  if (resolveAdapterOverride?.createMemoryKeyValueStore) {
    return {
      createMemoryKeyValueStore: resolveAdapterOverride.createMemoryKeyValueStore,
    };
  }

  return import('./adapters/memory-adapter');
}

async function getSQLiteAdapter() {
  const resolveAdapterOverride = getResolveAdapterOverride();
  const adapter = await import('./adapters/sqlite-adapter');

  return {
    createSQLiteKeyValueStore:
      resolveAdapterOverride?.createSQLiteKeyValueStore ?? adapter.createSQLiteKeyValueStore,
    isSQLiteAvailable: resolveAdapterOverride?.isSQLiteAvailable ?? adapter.isSQLiteAvailable,
  };
}

async function getIndexedDBAdapter() {
  const resolveAdapterOverride = getResolveAdapterOverride();
  const adapter = await import('./adapters/indexeddb-adapter');

  return {
    createIndexedDBKeyValueStore:
      resolveAdapterOverride?.createIndexedDBKeyValueStore ?? adapter.createIndexedDBKeyValueStore,
    isIndexedDBAvailable:
      resolveAdapterOverride?.isIndexedDBAvailable ?? adapter.isIndexedDBAvailable,
  };
}

async function getChromeStorageAdapter() {
  const resolveAdapterOverride = getResolveAdapterOverride();
  const adapter = await import('./adapters/chrome-storage-adapter');

  return {
    createChromeKeyValueStore:
      resolveAdapterOverride?.createChromeKeyValueStore ?? adapter.createChromeKeyValueStore,
    isChromeStorageAvailable:
      resolveAdapterOverride?.isChromeStorageAvailable ?? adapter.isChromeStorageAvailable,
  };
}

async function getRemoteAdapter() {
  const resolveAdapterOverride = getResolveAdapterOverride();
  if (resolveAdapterOverride?.createRemoteKeyValueStore) {
    return {
      createRemoteKeyValueStore: resolveAdapterOverride.createRemoteKeyValueStore,
    };
  }

  return import('./adapters/remote-adapter');
}

async function resolveAutomaticKeyValueStore(): Promise<KeyValueStore> {
  const { isSQLiteAvailable, createSQLiteKeyValueStore } = await getSQLiteAdapter();
  if (isSQLiteAvailable()) {
    return createSQLiteKeyValueStore({ filename: ':memory:' });
  }

  const { isChromeStorageAvailable, createChromeKeyValueStore } = await getChromeStorageAdapter();
  if (isChromeStorageAvailable()) {
    return createChromeKeyValueStore();
  }

  const { isIndexedDBAvailable, createIndexedDBKeyValueStore } = await getIndexedDBAdapter();
  if (isIndexedDBAvailable()) {
    return createIndexedDBKeyValueStore();
  }

  const { createMemoryKeyValueStore } = await getMemoryAdapter();
  return createMemoryKeyValueStore();
}

/**
 * Resolve a KeyValueStore from a configuration object.
 *
 * For `{ type: 'auto' }`, the resolver picks the best adapter available in
 * the current runtime: SQLite under Bun, falling back to in-memory.
 */
export async function resolveKeyValueStore(
  configuration: KeyValueStoreConfiguration,
): Promise<KeyValueStore> {
  switch (configuration.type) {
    case 'memory': {
      const { createMemoryKeyValueStore } = await getMemoryAdapter();
      return createMemoryKeyValueStore();
    }
    case 'sqlite': {
      const { createSQLiteKeyValueStore } = await getSQLiteAdapter();
      return createSQLiteKeyValueStore({ filename: configuration.path });
    }
    case 'indexeddb': {
      const { createIndexedDBKeyValueStore } = await getIndexedDBAdapter();
      return createIndexedDBKeyValueStore({ databaseName: configuration.databaseName });
    }
    case 'chrome-storage': {
      const { createChromeKeyValueStore } = await getChromeStorageAdapter();
      return createChromeKeyValueStore({ area: configuration.area });
    }
    case 'remote': {
      const { createRemoteKeyValueStore } = await getRemoteAdapter();
      return createRemoteKeyValueStore({
        baseUrl: configuration.baseUrl,
        headers: configuration.headers,
      });
    }
    case 'auto':
      return resolveAutomaticKeyValueStore();
  }
}
