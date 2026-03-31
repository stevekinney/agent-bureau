import {
  createMemoryKeyValueStore,
  createSQLiteKeyValueStore,
  type KeyValueStore,
  type KeyValueStoreConfiguration,
} from 'storage';
import type { StorageAdapter } from 'vector-frankl';

// ── Configuration ────────────────────────────────────────────────────

export type StorageBackendConfiguration = KeyValueStoreConfiguration;

// ── Resolved Backend ─────────────────────────────────────────────────

export interface ResolvedStorageBackend {
  vector: StorageAdapter;
  kv: KeyValueStore;
}

async function resolveAutomaticBackend(): Promise<ResolvedStorageBackend> {
  const { isSQLiteAvailable } = await import('storage');

  if (isSQLiteAvailable()) {
    const { SQLiteStorageAdapter } = await import('vector-frankl');
    return {
      kv: await createSQLiteKeyValueStore({ filename: ':memory:' }),
      vector: new SQLiteStorageAdapter({ filename: ':memory:' }),
    };
  }

  const { MemoryStorageAdapter } = await import('vector-frankl');
  return {
    kv: createMemoryKeyValueStore(),
    vector: new MemoryStorageAdapter(),
  };
}

// ── Resolver ─────────────────────────────────────────────────────────

export async function resolveStorageBackend(
  configuration: StorageBackendConfiguration,
): Promise<ResolvedStorageBackend> {
  switch (configuration.type) {
    case 'memory': {
      const { MemoryStorageAdapter } = await import('vector-frankl');
      return {
        kv: createMemoryKeyValueStore(),
        vector: new MemoryStorageAdapter(),
      };
    }
    case 'sqlite': {
      const { SQLiteStorageAdapter } = await import('vector-frankl');
      return {
        kv: await createSQLiteKeyValueStore({ filename: configuration.path }),
        vector: new SQLiteStorageAdapter({ filename: configuration.path }),
      };
    }
    case 'auto':
      return resolveAutomaticBackend();
    case 'chrome-storage':
    case 'indexeddb':
    case 'remote':
      throw new Error(
        `Gateway vector storage does not support the "${configuration.type}" key-value backend yet.`,
      );
  }
}
