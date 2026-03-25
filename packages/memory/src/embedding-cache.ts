import type { Embedder, EmbeddingVector } from 'interoperability';

export interface EmbeddingCacheOptions {
  /** Maximum number of entries to retain. Default: 10_000 */
  maximumEntries?: number;
  /** Custom hash function. Default: SHA-256 hex via Web Crypto. */
  hash?: (text: string) => string | Promise<string>;
}

export type CachedEmbedder = Embedder & {
  /** Read-only view of the current cache contents. */
  cache: ReadonlyMap<string, EmbeddingVector>;
  /** Clear all cached entries. */
  clearCache(): void;
};

const DEFAULT_MAXIMUM_ENTRIES = 10_000;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Wraps an Embedder with an in-memory LRU cache keyed by content hash.
 *
 * Cached entries are looked up before calling the wrapped embedder, and only
 * cache misses are forwarded. Results are reassembled in the original order.
 */
export function withEmbeddingCache(
  embedder: Embedder,
  options?: EmbeddingCacheOptions,
): CachedEmbedder {
  const maximumEntries = options?.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
  const hashFunction = options?.hash ?? sha256Hex;

  // Map preserves insertion order — we use this for LRU eviction.
  const cache = new Map<string, EmbeddingVector>();

  function evictIfNeeded(): void {
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }

  function touchEntry(key: string, value: EmbeddingVector): void {
    // Move to end of insertion order by deleting and re-inserting.
    cache.delete(key);
    cache.set(key, value);
  }

  const cachedEmbedder: CachedEmbedder = Object.assign(
    async (texts: string[]): Promise<EmbeddingVector[]> => {
      if (texts.length === 0) return [];

      // Hash all inputs.
      const hashes = await Promise.all(texts.map(async (text) => hashFunction(text)));

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
      },
    },
  );

  return cachedEmbedder;
}
