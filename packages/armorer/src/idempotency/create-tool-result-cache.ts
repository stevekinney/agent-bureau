import { createCompletedEntry, decodeEntry, encodeEntry, isExpired } from './cache-entry-codec';
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

const sharedLocks = new WeakMap<object, Map<string, Promise<unknown>>>();

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
  /** Cache wall clock used to stamp and evaluate expiration. Defaults to Date.now. */
  now?: () => number;
};

/**
 * Creates a process-local ToolResultCache backed by a KeyValueStore.
 *
 * Serializes CachedToolResult objects as JSON strings. Entries are checked for
 * TTL expiration on read — expired entries are treated as cache misses and
 * cleaned up lazily. Atomicity is provided only among cache instances in this
 * JavaScript process that share the same store object. Distributed hosts must
 * implement ToolResultCache with storage-native compare-and-set operations,
 * including the fenced and legacy started-entry replacement methods.
 */
export function createToolResultCache(options: CreateToolResultCacheOptions): ToolResultCache {
  const { store, defaultTTL, namespace, now = Date.now } = options;

  const prefix = namespace ? `${namespace}:` : '';
  const locksByStore = sharedLocks.get(store) ?? new Map<string, Promise<unknown>>();
  sharedLocks.set(store, locksByStore);

  function resolveKey(key: string): string {
    return `${prefix}${key}`;
  }

  async function getEntry(key: string): Promise<ToolResultCacheEntry | undefined> {
    const raw = await store.get(resolveKey(key));
    if (raw === null) {
      return undefined;
    }

    let entry: ToolResultCacheEntry | undefined;
    try {
      entry = decodeEntry(JSON.parse(raw), defaultTTL);
    } catch {
      entry = undefined;
    }

    if (!entry) {
      await store.delete(resolveKey(key));
      return undefined;
    }

    if (isExpired(entry, now)) {
      // Lazily clean up expired entries
      await store.delete(resolveKey(key));
      return undefined;
    }

    return entry;
  }

  async function withKeyClaimLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locksByStore.get(key);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    locksByStore.set(key, current);
    try {
      return await current;
    } finally {
      if (locksByStore.get(key) === current) {
        locksByStore.delete(key);
      }
    }
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
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing) {
          return { outcome: 'existing', entry: existing };
        }

        const effectiveTTL = ttl ?? (execution.ttl !== undefined ? execution.ttl : defaultTTL);
        const entry = effectiveTTL !== undefined ? { ...execution, ttl: effectiveTTL } : execution;
        await store.set(resolveKey(key), JSON.stringify(encodeEntry(entry)));
        return { outcome: 'claimed' };
      });
    },

    async set(key: string, result: CachedToolResult, ttl?: number): Promise<void> {
      // Priority: explicit ttl param > entry's own ttl (including 0 = never expire) > defaultTTL
      const effectiveTTL = ttl ?? (result.ttl !== undefined ? result.ttl : defaultTTL);
      const entry =
        effectiveTTL !== undefined
          ? {
              ...result,
              status: 'completed' as const,
              ttl: effectiveTTL,
              ...(effectiveTTL === 0 ? {} : { expiresAt: now() + effectiveTTL }),
            }
          : { ...result, status: 'completed' as const };
      await store.set(resolveKey(key), JSON.stringify(encodeEntry(entry)));
    },

    async renewStarted(
      key: string,
      attemptId: string,
      leaseExpiresAt: number,
      observedAt: number,
    ): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing?.status !== 'started' || existing.attemptId !== attemptId) return false;
        if (existing.absoluteDeadline !== undefined && observedAt >= existing.absoluteDeadline) {
          return false;
        }
        if (existing.absoluteDeadline !== undefined && leaseExpiresAt > existing.absoluteDeadline) {
          leaseExpiresAt = existing.absoluteDeadline;
        }
        await store.set(
          resolveKey(key),
          JSON.stringify(encodeEntry({ ...existing, leaseExpiresAt })),
        );
        return true;
      });
    },

    async completeStarted(
      key: string,
      attemptId: string,
      result: CachedToolResult,
      ttl?: number,
      observedAt = now(),
    ): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing?.status !== 'started' || existing.attemptId !== attemptId) return false;
        if (existing.absoluteDeadline !== undefined && observedAt >= existing.absoluteDeadline) {
          return false;
        }
        const entry = createCompletedEntry(result, ttl, defaultTTL, now);
        await store.set(resolveKey(key), JSON.stringify(encodeEntry(entry)));
        return true;
      });
    },

    async replaceUnknownStarted(
      key: string,
      expectedAttemptId: string,
      execution: StartedToolExecution,
      observedAt: number,
    ): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing?.status !== 'started' || existing.attemptId !== expectedAttemptId) {
          return false;
        }
        if (existing.leaseExpiresAt !== undefined && observedAt < existing.leaseExpiresAt) {
          return false;
        }
        await store.set(resolveKey(key), JSON.stringify(encodeEntry(execution)));
        return true;
      });
    },

    async replaceLegacyStarted(
      key: string,
      expected: { toolName: string; startedAt: number },
      execution: StartedToolExecution,
      observedAt: number,
    ): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (
          existing?.status !== 'started' ||
          existing.attemptId !== undefined ||
          existing.toolName !== expected.toolName ||
          existing.startedAt !== expected.startedAt ||
          !execution.attemptId
        ) {
          return false;
        }
        if (existing.leaseExpiresAt !== undefined && observedAt < existing.leaseExpiresAt) {
          return false;
        }
        await store.set(resolveKey(key), JSON.stringify(encodeEntry(execution)));
        return true;
      });
    },

    async deleteStarted(key: string, attemptId: string): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing?.status !== 'started' || existing.attemptId !== attemptId) return false;
        await store.delete(resolveKey(key));
        return true;
      });
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
