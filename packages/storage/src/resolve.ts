import { createMemoryKeyValueStore } from './adapters/memory-adapter';
import { createSQLiteKeyValueStore, isSQLiteAvailable } from './adapters/sqlite-adapter';
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
      console.log('[storage] resolved adapter: memory');
      return createMemoryKeyValueStore();
    }
    case 'sqlite': {
      console.log('[storage] resolved adapter: sqlite');
      return createSQLiteKeyValueStore({ filename: configuration.path });
    }
    case 'auto': {
      if (isSQLiteAvailable()) {
        console.log('[storage] resolved adapter: sqlite (auto-detected)');
        return createSQLiteKeyValueStore({ filename: ':memory:' });
      }
      console.log('[storage] resolved adapter: memory (auto-detected)');
      return createMemoryKeyValueStore();
    }
    case 'indexeddb':
      throw new Error('IndexedDB adapter is not yet implemented');
    case 'chrome-storage':
      throw new Error('Chrome storage adapter is not yet implemented');
    case 'remote':
      throw new Error('Remote adapter is not yet implemented');
  }
}
