import type { StorageAdapter } from 'vector-frankl';

import type { CachedEmbedder } from './embedding-cache';

export interface MemoryStatus {
  totalEntries: number;
  namespaces: Array<{ name: string; count: number }>;
  storageType: string;
  embeddingCacheSize?: number;
}

const METADATA_NAMESPACE_KEY = '__memory_namespace';

/**
 * Gathers status information about a memory instance.
 *
 * Provides entry counts, namespace breakdown, storage type, and
 * optional embedding cache size for observability.
 */
export async function getMemoryStatus(
  storage: StorageAdapter,
  options?: { embedder?: unknown; storageType?: string },
): Promise<MemoryStatus> {
  const all = await storage.getAll();
  const totalEntries = all.length;

  // Build namespace breakdown.
  const namespaceCounts = new Map<string, number>();
  for (const entry of all) {
    const namespace = (entry.metadata?.[METADATA_NAMESPACE_KEY] as string) ?? 'default';
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
  }

  const namespaces = Array.from(namespaceCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const storageType = options?.storageType ?? storage.constructor.name;

  // Check if the embedder has a cache property (CachedEmbedder).
  let embeddingCacheSize: number | undefined;
  const embedder = options?.embedder;
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
