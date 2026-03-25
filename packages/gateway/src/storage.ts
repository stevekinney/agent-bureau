import type { SessionPersistenceAdapter } from 'conversationalist';
import type { StorageAdapter } from 'vector-frankl';

// ── Configuration ────────────────────────────────────────────────────

export type StorageBackendConfiguration = { type: 'memory' } | { type: 'sqlite'; path: string };

// ── Resolved Backend ─────────────────────────────────────────────────

export interface ResolvedStorageBackend {
  persistence: SessionPersistenceAdapter;
  vector: StorageAdapter;
}

// ── Resolver ─────────────────────────────────────────────────────────

export async function resolveStorageBackend(
  configuration: StorageBackendConfiguration,
): Promise<ResolvedStorageBackend> {
  switch (configuration.type) {
    case 'memory': {
      const { createInMemoryPersistenceAdapter } = await import('conversationalist');
      const { MemoryStorageAdapter } = await import('vector-frankl');
      return {
        persistence: createInMemoryPersistenceAdapter(),
        vector: new MemoryStorageAdapter(),
      };
    }
    case 'sqlite': {
      const { createSQLitePersistenceAdapter } = await import('conversationalist');
      const { SQLiteStorageAdapter } = await import('vector-frankl');
      return {
        persistence: await createSQLitePersistenceAdapter({ path: configuration.path }),
        vector: new SQLiteStorageAdapter({ filename: configuration.path }),
      };
    }
  }
}

/**
 * Resolves only the persistence adapter from a storage backend configuration.
 *
 * Use this when only session persistence is needed and vector storage
 * should not be eagerly constructed (avoids opening files/handles).
 */
export async function resolvePersistenceAdapter(
  configuration: StorageBackendConfiguration,
): Promise<SessionPersistenceAdapter> {
  switch (configuration.type) {
    case 'memory': {
      const { createInMemoryPersistenceAdapter } = await import('conversationalist');
      return createInMemoryPersistenceAdapter();
    }
    case 'sqlite': {
      const { createSQLitePersistenceAdapter } = await import('conversationalist');
      return createSQLitePersistenceAdapter({ path: configuration.path });
    }
  }
}
