import type { CachedEmbedder } from './embedding-cache';
import type { MemoryRecordStorage } from './memory-record-storage';

export interface MemoryStatus {
  totalEntries: number;
  namespaces: Array<{ name: string; count: number }>;
  storageType: string;
  embeddingCacheSize?: number;
}

/**
 * Options for {@link getMemoryStatus}.
 */
export interface GetMemoryStatusOptions {
  /**
   * Namespaces to report on. Required because {@link MemoryRecordStorage} is
   * scope-keyed and exposes no cross-scope enumeration: status can only count
   * the scopes a caller names. Each namespace is counted via `storage.count()`
   * and `totalEntries` is their sum.
   */
  namespaces: string[];
  /** Optional tenant the namespaces belong to. */
  tenantId?: string;
  /** Embedder, inspected for an optional embedding cache size. */
  embedder?: unknown;
  /** Human-readable storage label. Defaults to the storage object's constructor name. */
  storageType?: string;
}

/**
 * Gathers status information about a memory instance.
 *
 * Provides per-namespace entry counts (sorted by count, descending), a total
 * across the requested namespaces, the storage type, and an optional embedding
 * cache size for observability. Because the storage contract is scope-keyed,
 * the namespaces to report on must be supplied explicitly via `options`.
 */
export async function getMemoryStatus(
  storage: MemoryRecordStorage,
  options: GetMemoryStatusOptions,
): Promise<MemoryStatus> {
  const tenantId = options.tenantId;

  const namespaces = await Promise.all(
    options.namespaces.map(async (name) => ({
      name,
      count: await storage.count({
        ...(tenantId !== undefined ? { tenantId } : {}),
        namespace: name,
      }),
    })),
  );
  namespaces.sort((a, b) => b.count - a.count);

  const totalEntries = namespaces.reduce((sum, namespace) => sum + namespace.count, 0);

  const storageType = options.storageType ?? storage.constructor.name;

  // Check if the embedder has a cache property (CachedEmbedder).
  let embeddingCacheSize: number | undefined;
  const embedder = options.embedder;
  if (embedder && typeof embedder === 'function' && 'cache' in embedder) {
    const cache = (embedder as CachedEmbedder).cache;
    if (cache instanceof Map || (cache && typeof cache.size === 'number')) {
      embeddingCacheSize = cache.size;
    }
  }

  return {
    totalEntries,
    namespaces,
    storageType,
    embeddingCacheSize,
  };
}
