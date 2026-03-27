import type { KeyValueStore, KeyValueStoreConfiguration } from './types';

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
      const { createMemoryKeyValueStore } = await import('./adapters/memory-adapter');
      return createMemoryKeyValueStore();
    }
    case 'sqlite': {
      const { createSQLiteKeyValueStore } = await import('./adapters/sqlite-adapter');
      return createSQLiteKeyValueStore({ filename: configuration.path });
    }
    case 'indexeddb': {
      const { createIndexedDBKeyValueStore } = await import('./adapters/indexeddb-adapter');
      return createIndexedDBKeyValueStore({ databaseName: configuration.databaseName });
    }
    case 'chrome-storage': {
      const { createChromeKeyValueStore } = await import('./adapters/chrome-storage-adapter');
      return createChromeKeyValueStore({ area: configuration.area });
    }
    case 'remote': {
      const { createRemoteKeyValueStore } = await import('./adapters/remote-adapter');
      return createRemoteKeyValueStore({
        baseUrl: configuration.baseUrl,
        headers: configuration.headers,
      });
    }
    case 'auto': {
      const { isSQLiteAvailable } = await import('./adapters/sqlite-adapter');
      if (isSQLiteAvailable()) {
        const { createSQLiteKeyValueStore } = await import('./adapters/sqlite-adapter');
        return createSQLiteKeyValueStore({ filename: ':memory:' });
      }
      const { createMemoryKeyValueStore } = await import('./adapters/memory-adapter');
      return createMemoryKeyValueStore();
    }
  }
}
