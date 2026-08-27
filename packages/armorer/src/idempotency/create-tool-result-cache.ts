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

const RESULT_UNDEFINED_SENTINEL = '__armorerResultUndefined';
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
        ...(typeof value['attemptId'] === 'string' ? { attemptId: value['attemptId'] } : {}),
        ...(typeof value['leaseExpiresAt'] === 'number'
          ? { leaseExpiresAt: value['leaseExpiresAt'] }
          : {}),
        ...(typeof value['absoluteDeadline'] === 'number'
          ? { absoluteDeadline: value['absoluteDeadline'] }
          : {}),
      };
    }

    const hasResult = 'result' in value || value[RESULT_UNDEFINED_SENTINEL] === true;
    if (
      (value['status'] === undefined || value['status'] === 'completed') &&
      hasResult &&
      typeof value['toolName'] === 'string' &&
      typeof value['executedAt'] === 'number'
    ) {
      return {
        status: 'completed',
        result: value[RESULT_UNDEFINED_SENTINEL] === true ? undefined : value['result'],
        toolName: value['toolName'],
        executedAt: value['executedAt'],
        ttl: typeof value['ttl'] === 'number' ? value['ttl'] : (defaultTTL ?? 0),
        ...(typeof value['expiresAt'] === 'number' ? { expiresAt: value['expiresAt'] } : {}),
      };
    }

    return undefined;
  }

  function isExpired(entry: ToolResultCacheEntry): boolean {
    // A started marker becoming old never proves that its side effect did not
    // happen. It remains an unknown outcome until an authorized receipt
    // atomically replaces it.
    if (entry.status === 'started') return false;
    if (entry.ttl === 0) return false;
    return now() > (entry.expiresAt ?? getEntryTime(entry) + entry.ttl);
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

  function encodeEntry(entry: ToolResultCacheEntry): Record<string, unknown> {
    if (entry.status === 'started' || entry.result !== undefined) {
      return entry;
    }

    const { result: _result, ...encoded } = entry;
    return {
      ...encoded,
      [RESULT_UNDEFINED_SENTINEL]: true,
    };
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
      observedAt = Date.now(),
    ): Promise<boolean> {
      return withKeyClaimLock(resolveKey(key), async () => {
        const existing = await getEntry(key);
        if (existing?.status !== 'started' || existing.attemptId !== attemptId) return false;
        if (existing.absoluteDeadline !== undefined && observedAt >= existing.absoluteDeadline) {
          return false;
        }
        const effectiveTTL = ttl ?? result.ttl ?? defaultTTL;
        const entry = {
          ...result,
          status: 'completed' as const,
          ...(effectiveTTL !== undefined ? { ttl: effectiveTTL } : {}),
          ...(effectiveTTL !== undefined && effectiveTTL !== 0
            ? { expiresAt: now() + effectiveTTL }
            : {}),
        };
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
