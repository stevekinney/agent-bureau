import type { Embedder } from 'interoperability';
import { SQLiteStorageAdapter } from 'vector-frankl';

import { createMemory } from './create-memory';
import type { EmbeddingCacheOptions } from './embedding-cache';
import { withEmbeddingCache } from './embedding-cache';
import { createFts5TextSearchProvider } from './fts5-text-search-provider';
import type { CreateMemoryOptions, Memory, MemorySearchOptions } from './types';

export { SQLiteStorageAdapter } from 'vector-frankl';

export interface CreateSQLiteMemoryOptions {
  embedder: Embedder;
  /** Path to the SQLite database file, or ':memory:' for in-memory. */
  filename: string;
  namespace?: string;
  dimension?: number;
  defaultSearchOptions?: Partial<MemorySearchOptions>;
  deduplicationThreshold?: number;
  /** Enable embedding cache. Pass `true` for defaults or an options object. */
  embeddingCache?: EmbeddingCacheOptions | boolean;
  /** Disable FTS5 text search integration. Default: false (FTS5 is enabled). */
  disableFts5?: boolean;
}

/**
 * Creates a Memory instance backed by SQLite storage.
 *
 * This is a convenience factory that composes `createMemory` with
 * `SQLiteStorageAdapter` from vector-frankl, automatically wires FTS5
 * text search, and optionally wraps the embedder with an embedding cache.
 */
export function createSQLiteMemory(options: CreateSQLiteMemoryOptions): Memory {
  const { embedder, filename, embeddingCache, disableFts5, ...rest } = options;

  const storage = new SQLiteStorageAdapter({ filename });

  let resolvedEmbedder: Embedder = embedder;
  if (embeddingCache) {
    const cacheOptions = typeof embeddingCache === 'object' ? embeddingCache : undefined;
    resolvedEmbedder = withEmbeddingCache(embedder, cacheOptions);
  }

  const memoryOptions: CreateMemoryOptions = {
    embedder: resolvedEmbedder,
    storage,
    ...rest,
  };

  if (!disableFts5) {
    memoryOptions.textSearchProvider = createFts5TextSearchProvider({ filename });
  }

  return createMemory(memoryOptions);
}
