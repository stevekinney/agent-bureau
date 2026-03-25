import type { Embedder, EmbeddingVector } from 'interoperability';

import { sha256Hex } from './hash';

export interface EmbeddingCacheOptions {
  /** Maximum number of entries to retain. Default: 10_000 */
  maximumEntries?: number;
  /** Custom hash function. Default: SHA-256 hex via Web Crypto. */
  hash?: (text: string) => string | Promise<string>;
  /**
   * When set, all cache keys are prefixed with this namespace.
   * This provides true tenant isolation — the same text in different
   * namespaces produces different cache keys.
   */
  namespace?: string;
}

export type CachedEmbedder = Embedder & {
  /** Read-only view of the current cache contents. */
  cache: ReadonlyMap<string, EmbeddingVector>;
  /** Clear all cached entries. */
  clearCache(): void;
  /**
   * Evict all cache entries associated with a specific namespace.
   * Only meaningful when cache entries were created with a namespace prefix.
   */
  clearNamespace(namespace: string): void;
};

const DEFAULT_MAXIMUM_ENTRIES = 10_000;

/**
 * Wraps an Embedder with an in-memory LRU cache keyed by content hash.
 *
 * Cached entries are looked up before calling the wrapped embedder, and only
 * cache misses are forwarded. Results are reassembled in the original order.
 *
 * When `namespace` is set in options, cache keys include the namespace prefix
 * for tenant isolation. Use `clearNamespace()` to evict entries for a
 * specific namespace without affecting others.
 */
export function withEmbeddingCache(
  embedder: Embedder,
  options?: EmbeddingCacheOptions,
): CachedEmbedder {
  const maximumEntries = options?.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
  const hashFunction = options?.hash ?? sha256Hex;
  const defaultNamespace = options?.namespace;

  // Map preserves insertion order — we use this for LRU eviction.
  const cache = new Map<string, EmbeddingVector>();

  // Secondary index: namespace → set of cache keys, for O(1) namespace eviction.
  const namespaceKeys = new Map<string, Set<string>>();

  function trackNamespaceKey(namespace: string | undefined, key: string): void {
    if (namespace === undefined) return;
    let keys = namespaceKeys.get(namespace);
    if (!keys) {
      keys = new Set();
      namespaceKeys.set(namespace, keys);
    }
    keys.add(key);
  }

  function removeFromNamespaceIndex(key: string): void {
    for (const keys of namespaceKeys.values()) {
      if (keys.delete(key)) break; // each key belongs to at most one namespace
    }
  }

  function evictIfNeeded(): void {
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      removeFromNamespaceIndex(oldest);
    }
  }

  function touchEntry(key: string, value: EmbeddingVector): void {
    // Move to end of insertion order by deleting and re-inserting.
    cache.delete(key);
    cache.set(key, value);
  }

  async function computeKey(text: string): Promise<string> {
    if (defaultNamespace !== undefined) {
      return hashFunction(`${defaultNamespace}:${text}`);
    }
    return hashFunction(text);
  }

  const cachedEmbedder: CachedEmbedder = Object.assign(
    async (texts: string[]): Promise<EmbeddingVector[]> => {
      if (texts.length === 0) return [];

      // Hash all inputs.
      const hashes = await Promise.all(texts.map(async (text) => computeKey(text)));

      // Partition into hits and misses, tracking original indices.
      const results: (EmbeddingVector | undefined)[] = new Array<EmbeddingVector | undefined>(
        texts.length,
      );
      const missIndices: number[] = [];
      const missTexts: string[] = [];

      for (let i = 0; i < texts.length; i++) {
        const hash = hashes[i]!;
        const cached = cache.get(hash);
        if (cached !== undefined) {
          touchEntry(hash, cached);
          results[i] = cached;
        } else {
          missIndices.push(i);
          missTexts.push(texts[i]!);
        }
      }

      // Fetch only the misses from the real embedder.
      if (missTexts.length > 0) {
        const freshVectors = await embedder(missTexts);
        for (let j = 0; j < missIndices.length; j++) {
          const originalIndex = missIndices[j]!;
          const vector = freshVectors[j]!;
          const hash = hashes[originalIndex]!;
          cache.set(hash, vector);
          trackNamespaceKey(defaultNamespace, hash);
          results[originalIndex] = vector;
        }
        evictIfNeeded();
      }

      return results as EmbeddingVector[];
    },
    {
      cache: cache as ReadonlyMap<string, EmbeddingVector>,

      clearCache(): void {
        cache.clear();
        namespaceKeys.clear();
      },

      clearNamespace(namespace: string): void {
        const keys = namespaceKeys.get(namespace);
        if (!keys) return;
        for (const key of keys) {
          cache.delete(key);
        }
        namespaceKeys.delete(namespace);
      },
    },
  );

  return cachedEmbedder;
}
