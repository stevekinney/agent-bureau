import type { Embedder, EmbeddingVector } from '@lostgradient/embeddings';

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
  /**
   * Evict every entry whose embedded text has one of these SHA-256 hex digests,
   * whatever the namespace or key hash. Governed memory's deletion uses it to
   * evict a deleted record's content after the record itself is gone. Returns
   * how many entries were evicted.
   */
  evictContent(contentDigests: readonly string[]): number;
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
  // Reverse index: cache key → namespace, for O(1) eviction cleanup.
  const keyToNamespace = new Map<string, string>();
  // Content index: SHA-256 digest of the embedded text → cache keys, and back.
  const digestKeys = new Map<string, Set<string>>();
  const keyToDigest = new Map<string, string>();
  // Without a namespace or custom hash, a key already is the text's SHA-256 digest.
  const keysAreDigests = defaultNamespace === undefined && options?.hash === undefined;

  function addToIndex(index: Map<string, Set<string>>, group: string, key: string): void {
    let keys = index.get(group);
    if (!keys) {
      keys = new Set();
      index.set(group, keys);
    }
    keys.add(key);
  }

  function removeFromIndex(
    index: Map<string, Set<string>>,
    reverse: Map<string, string>,
    key: string,
  ): void {
    const group = reverse.get(key);
    if (group === undefined) return;
    reverse.delete(key);
    const keys = index.get(group)!;
    keys.delete(key);
    if (keys.size === 0) index.delete(group);
  }

  function trackKey(key: string, digest: string): void {
    addToIndex(digestKeys, digest, key);
    keyToDigest.set(key, digest);
    if (defaultNamespace === undefined) return;
    addToIndex(namespaceKeys, defaultNamespace, key);
    keyToNamespace.set(key, defaultNamespace);
  }

  function forgetKey(key: string): void {
    cache.delete(key);
    removeFromIndex(namespaceKeys, keyToNamespace, key);
    removeFromIndex(digestKeys, keyToDigest, key);
  }

  function evictIfNeeded(): void {
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) return;
      forgetKey(oldest);
    }
  }

  function touchEntry(key: string, value: EmbeddingVector): void {
    // Move to end of insertion order by deleting and re-inserting.
    cache.delete(key);
    cache.set(key, value);
  }

  async function computeKey(text: string): Promise<string> {
    if (defaultNamespace !== undefined) {
      // Use unambiguous structured encoding to avoid collisions when namespace or text contain ':'.
      return hashFunction(JSON.stringify([defaultNamespace, text]));
    }
    return hashFunction(text);
  }

  const cachedEmbedder: CachedEmbedder = Object.assign(
    async (texts: string[]): Promise<EmbeddingVector[]> => {
      if (texts.length === 0) return [];

      // Hash all inputs.
      const hashes = await Promise.all(texts.map(async (text) => computeKey(text)));

      // Partition into hits and misses, tracking original indices.
      const results: (EmbeddingVector | undefined)[] = Array.from({ length: texts.length });
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
          trackKey(hash, keysAreDigests ? hash : await sha256Hex(missTexts[j]!));
          results[originalIndex] = vector;
        }
        evictIfNeeded();
      }

      return results.filter((result): result is EmbeddingVector => result !== undefined);
    },
    {
      cache: cache,

      clearCache(): void {
        cache.clear();
        namespaceKeys.clear();
        keyToNamespace.clear();
        digestKeys.clear();
        keyToDigest.clear();
      },

      clearNamespace(namespace: string): void {
        // Deleting the visited key while iterating a Set is well-defined.
        for (const key of namespaceKeys.get(namespace) ?? []) forgetKey(key);
      },

      evictContent(contentDigests: readonly string[]): number {
        let evicted = 0;
        for (const digest of contentDigests) {
          for (const key of digestKeys.get(digest) ?? []) {
            forgetKey(key);
            evicted++;
          }
        }
        return evicted;
      },
    },
  );

  return cachedEmbedder;
}
