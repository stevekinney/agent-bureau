import type { CachedToolResult, ToolResultCache } from './types';

/**
 * Minimal store interface matching KeyValueStore from the storage package.
 * Declared locally so armorer does not depend on storage at build time.
 */
type KeyValueStoreLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
};

/**
 * Options for creating a tool result cache.
 */
export type CreateToolResultCacheOptions = {
  /** The underlying key-value store for persistence. */
  store: KeyValueStoreLike;
  /** Default TTL in milliseconds for cached entries. Defaults to 300000 (5 minutes). */
  defaultTTL?: number;
  /** Optional key prefix applied to all cache keys. */
  namespace?: string;
};

/**
 * Creates a ToolResultCache backed by a KeyValueStore.
 *
 * Serializes CachedToolResult objects as JSON strings. Entries are checked for
 * TTL expiration on read — expired entries are treated as cache misses and
 * cleaned up lazily.
 */
export function createToolResultCache(options: CreateToolResultCacheOptions): ToolResultCache {
  const { store, defaultTTL, namespace } = options;

  const prefix = namespace ? `${namespace}:` : '';

  function resolveKey(key: string): string {
    return `${prefix}${key}`;
  }

  function isExpired(entry: CachedToolResult): boolean {
    return Date.now() > entry.executedAt + entry.ttl;
  }

  return {
    async get(key: string): Promise<CachedToolResult | undefined> {
      const raw = await store.get(resolveKey(key));
      if (raw === null) {
        return undefined;
      }

      const entry = JSON.parse(raw) as CachedToolResult;

      if (isExpired(entry)) {
        // Lazily clean up expired entries
        await store.delete(resolveKey(key));
        return undefined;
      }

      return entry;
    },

    async set(key: string, result: CachedToolResult, ttl?: number): Promise<void> {
      // Priority: explicit ttl param > entry's own ttl > defaultTTL
      const effectiveTTL = ttl ?? (result.ttl > 0 ? result.ttl : defaultTTL);
      const entry = effectiveTTL !== undefined ? { ...result, ttl: effectiveTTL } : result;
      await store.set(resolveKey(key), JSON.stringify(entry));
    },

    async delete(key: string): Promise<void> {
      await store.delete(resolveKey(key));
    },

    async clear(): Promise<void> {
      const keys = await store.list(prefix);
      await Promise.all(keys.map((key) => store.delete(key)));
    },
  };
}
