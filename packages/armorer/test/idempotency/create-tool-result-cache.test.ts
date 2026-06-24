import { beforeEach, describe, expect, it } from 'bun:test';

import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';

/**
 * Minimal in-memory KeyValueStore for testing without depending on the storage package.
 */
function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
    _map: map,
  };
}

describe('createToolResultCache', () => {
  let store: ReturnType<typeof createTestStore>;
  let cache: ToolResultCache;

  beforeEach(() => {
    store = createTestStore();
    cache = createToolResultCache({ store, defaultTTL: 60_000 });
  });

  describe('set and get', () => {
    it('stores and retrieves a cached result', async () => {
      const result: CachedToolResult = {
        result: { answer: 42 },
        toolName: 'calculator',
        executedAt: Date.now(),
        ttl: 60_000,
      };

      await cache.set('key-1', result);
      const retrieved = await cache.get('key-1');

      expect(retrieved).toMatchObject(result);
    });

    it('returns undefined for a missing key', async () => {
      const retrieved = await cache.get('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('serializes result as JSON string in the underlying store', async () => {
      const result: CachedToolResult = {
        result: 'hello',
        toolName: 'greeter',
        executedAt: 1000,
        ttl: 5000,
      };

      await cache.set('key-2', result);
      const raw = await store.get('key-2');

      expect(typeof raw).toBe('string');
      expect(JSON.parse(raw!)).toMatchObject({
        ...result,
        status: 'completed',
      });
    });
  });

  describe('TTL expiration', () => {
    it('returns undefined for an expired entry', async () => {
      const result: CachedToolResult = {
        result: 'stale',
        toolName: 'old-tool',
        executedAt: Date.now() - 120_000, // 2 minutes ago
        ttl: 60_000, // 1 minute TTL
      };

      await cache.set('expired-key', result);
      const retrieved = await cache.get('expired-key');

      expect(retrieved).toBeUndefined();
    });

    it('returns the entry when TTL has not expired', async () => {
      const result: CachedToolResult = {
        result: 'fresh',
        toolName: 'new-tool',
        executedAt: Date.now() - 10_000, // 10 seconds ago
        ttl: 60_000, // 1 minute TTL
      };

      await cache.set('fresh-key', result);
      const retrieved = await cache.get('fresh-key');

      expect(retrieved).toMatchObject(result);
    });
  });

  describe('namespace', () => {
    it('prefixes keys with the namespace', async () => {
      const namespacedCache = createToolResultCache({
        store,
        namespace: 'test-ns',
      });

      const result: CachedToolResult = {
        result: 'namespaced',
        toolName: 'tool',
        executedAt: Date.now(),
        ttl: 60_000,
      };

      await namespacedCache.set('my-key', result);

      // The underlying store should have the namespaced key
      const raw = await store.get('test-ns:my-key');
      expect(raw).not.toBeNull();

      // Direct access without namespace prefix should return null
      const direct = await store.get('my-key');
      expect(direct).toBeNull();

      // Cache should still retrieve it via the original key
      const retrieved = await namespacedCache.get('my-key');
      expect(retrieved).toMatchObject(result);
    });
  });

  describe('delete', () => {
    it('removes a cached entry', async () => {
      const result: CachedToolResult = {
        result: 'doomed',
        toolName: 'tool',
        executedAt: Date.now(),
        ttl: 60_000,
      };

      await cache.set('to-delete', result);
      expect(await cache.get('to-delete')).toBeDefined();

      await cache.delete('to-delete');
      expect(await cache.get('to-delete')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all cached entries', async () => {
      const result: CachedToolResult = {
        result: 'value',
        toolName: 'tool',
        executedAt: Date.now(),
        ttl: 60_000,
      };

      await cache.set('a', result);
      await cache.set('b', result);

      await cache.clear();

      expect(await cache.get('a')).toBeUndefined();
      expect(await cache.get('b')).toBeUndefined();
    });
  });

  describe('started executions', () => {
    it('stores and retrieves a started state separately from completed results', async () => {
      await cache.markStarted('started-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: Date.now(),
        ttl: 60_000,
      });

      expect(await cache.get('started-key')).toBeUndefined();
      expect(await cache.getState('started-key')).toEqual({
        status: 'started',
        toolName: 'charge-card',
        startedAt: expect.any(Number),
        ttl: 60_000,
      });
    });
  });

  describe('defaultTTL', () => {
    it('returns an entry whose TTL has not yet expired', async () => {
      const defaultCache = createToolResultCache({ store });
      const result: CachedToolResult = {
        result: 'still-valid',
        toolName: 'tool',
        executedAt: Date.now() - 200_000, // 200 seconds ago, within 300s default
        ttl: 300_000,
      };

      await defaultCache.set('ttl-valid', result);
      const retrieved = await defaultCache.get('ttl-valid');
      expect(retrieved).toMatchObject(result);
    });

    it('treats an entry as expired when executedAt + ttl is in the past', async () => {
      const defaultCache = createToolResultCache({ store });
      const result: CachedToolResult = {
        result: 'expired',
        toolName: 'tool',
        executedAt: Date.now() - 400_000, // 400 seconds ago, beyond 300s default
        ttl: 300_000,
      };

      await defaultCache.set('ttl-expired', result);
      const retrieved = await defaultCache.get('ttl-expired');
      expect(retrieved).toBeUndefined();
    });
  });
});
