import type {
  CachedToolResult,
  StartedToolExecution,
  ToolResultCache,
  ToolResultCacheEntry,
} from './types';

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

  /** TTL of 0 means "never expire." */
  function getEntryTime(entry: ToolResultCacheEntry): number {
    return entry.status === 'started' ? entry.startedAt : entry.executedAt;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function decodeEntry(value: unknown): ToolResultCacheEntry | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    if (
      value['status'] === 'started' &&
      typeof value['toolName'] === 'string' &&
      typeof value['startedAt'] === 'number'
    ) {
      return {
        status: 'started',
        toolName: value['toolName'],
        startedAt: value['startedAt'],
        ttl: typeof value['ttl'] === 'number' ? value['ttl'] : (defaultTTL ?? 0),
      };
    }

    if (
      (value['status'] === undefined || value['status'] === 'completed') &&
      'result' in value &&
      typeof value['toolName'] === 'string' &&
      typeof value['executedAt'] === 'number'
    ) {
      return {
        status: 'completed',
        result: value['result'],
        toolName: value['toolName'],
        executedAt: value['executedAt'],
        ttl: typeof value['ttl'] === 'number' ? value['ttl'] : (defaultTTL ?? 0),
      };
    }

    return undefined;
  }

  function isExpired(entry: ToolResultCacheEntry): boolean {
    if (entry.ttl === 0) return false;
    return Date.now() > getEntryTime(entry) + entry.ttl;
  }

  async function getEntry(key: string): Promise<ToolResultCacheEntry | undefined> {
    const raw = await store.get(resolveKey(key));
    if (raw === null) {
      return undefined;
    }

    let entry: ToolResultCacheEntry | undefined;
    try {
      entry = decodeEntry(JSON.parse(raw));
    } catch {
      entry = undefined;
    }

    if (!entry) {
      await store.delete(resolveKey(key));
      return undefined;
    }

    if (isExpired(entry)) {
      // Lazily clean up expired entries
      await store.delete(resolveKey(key));
      return undefined;
    }

    return entry;
  }

  return {
    async get(key: string): Promise<CachedToolResult | undefined> {
      const entry = await getEntry(key);
      if (!entry || entry.status === 'started') {
        return undefined;
      }

      return entry;
    },

    getState: getEntry,

    async claimStarted(
      key: string,
      execution: StartedToolExecution,
      ttl?: number,
    ): Promise<{ outcome: 'claimed' } | { outcome: 'existing'; entry: ToolResultCacheEntry }> {
      const existing = await getEntry(key);
      if (existing) {
        return { outcome: 'existing', entry: existing };
      }

      const effectiveTTL = ttl ?? (execution.ttl !== undefined ? execution.ttl : defaultTTL);
      const entry = effectiveTTL !== undefined ? { ...execution, ttl: effectiveTTL } : execution;
      await store.set(resolveKey(key), JSON.stringify(entry));
      return { outcome: 'claimed' };
    },

    async set(key: string, result: CachedToolResult, ttl?: number): Promise<void> {
      // Priority: explicit ttl param > entry's own ttl (including 0 = never expire) > defaultTTL
      const effectiveTTL = ttl ?? (result.ttl !== undefined ? result.ttl : defaultTTL);
      const entry =
        effectiveTTL !== undefined
          ? { ...result, status: 'completed' as const, ttl: effectiveTTL }
          : { ...result, status: 'completed' as const };
      await store.set(resolveKey(key), JSON.stringify(entry));
    },

    async markStarted(key: string, execution: StartedToolExecution, ttl?: number): Promise<void> {
      const effectiveTTL = ttl ?? (execution.ttl !== undefined ? execution.ttl : defaultTTL);
      const entry = effectiveTTL !== undefined ? { ...execution, ttl: effectiveTTL } : execution;
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
