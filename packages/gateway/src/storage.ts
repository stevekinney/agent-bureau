import type { KeyValueStore } from 'storage';
import type { StorageAdapter } from 'vector-frankl';

// ── Configuration ────────────────────────────────────────────────────

export type StorageBackendConfiguration = { type: 'memory' } | { type: 'sqlite'; path: string };

// ── Resolved Backend ─────────────────────────────────────────────────

export interface ResolvedStorageBackend {
  vector: StorageAdapter;
  kv: KeyValueStore;
}

// ── Resolver ─────────────────────────────────────────────────────────

export async function resolveStorageBackend(
  configuration: StorageBackendConfiguration,
): Promise<ResolvedStorageBackend> {
  switch (configuration.type) {
    case 'memory': {
      const { createMemoryKeyValueStore } = await import('storage');
      const { MemoryStorageAdapter } = await import('vector-frankl');
      return {
        kv: createMemoryKeyValueStore(),
        vector: new MemoryStorageAdapter(),
      };
    }
    case 'sqlite': {
      const { createSQLiteKeyValueStore } = await import('storage');
      const { SQLiteStorageAdapter } = await import('vector-frankl');
      return {
        kv: await createSQLiteKeyValueStore({ filename: configuration.path }),
        vector: new SQLiteStorageAdapter({ filename: configuration.path }),
      };
    }
  }
}
