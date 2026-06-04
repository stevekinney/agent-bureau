import type { StorageConfiguration, TextValueStore } from '@lostgradient/weft/storage';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';
import type { StorageAdapter } from 'vector-frankl';
import { SQLiteStorageAdapter } from 'vector-frankl';

// ── Configuration ────────────────────────────────────────────────────

export type StorageBackendConfiguration = StorageConfiguration;

// ── Resolved Backend ─────────────────────────────────────────────────

export interface ResolvedStorageBackend {
  vector: StorageAdapter;
  kv: TextValueStore;
}

async function resolveAutomaticBackend(): Promise<ResolvedStorageBackend> {
  if (SQLiteStorageAdapter.isAvailable()) {
    return {
      kv: textValueStore(new SQLiteStorage(':memory:')),
      vector: new SQLiteStorageAdapter({ filename: ':memory:' }),
    };
  }

  const { MemoryStorageAdapter } = await import('vector-frankl');
  return {
    kv: textValueStore(new MemoryStorage()),
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
        kv: textValueStore(new MemoryStorage()),
        vector: new MemoryStorageAdapter(),
      };
    }
    case 'sqlite': {
      const filename = configuration.path ?? ':memory:';
      return {
        kv: textValueStore(new SQLiteStorage(filename)),
        vector: new SQLiteStorageAdapter({ filename }),
      };
    }
    case 'auto':
      return resolveAutomaticBackend();
    // TODO(weft-integration): wire vector-frankl adapters for the remaining
    // Weft storage backends (lmdb/turso/indexeddb/web-extension/http). The kv
    // half is supported by resolveStorage, but the paired vector adapter is not.
    case 'lmdb':
    case 'turso':
    case 'indexeddb':
    case 'web-extension':
    case 'http':
      throw new Error(
        `Gateway vector storage does not support the "${configuration.type}" key-value backend yet.`,
      );
  }
}
