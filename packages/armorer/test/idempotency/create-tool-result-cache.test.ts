import { beforeEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices, type ManualRuntimeServices } from 'lifecycle';

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
  let runtime: ManualRuntimeServices;

  beforeEach(() => {
    store = createTestStore();
    runtime = createManualRuntimeServices();
    cache = createToolResultCache({ store, defaultTTL: 60_000, now: runtime.clock.now });
  });

  describe('set and get', () => {
    it('stores and retrieves a cached result', async () => {
      const result: CachedToolResult = {
        result: { answer: 42 },
        toolName: 'calculator',
        executedAt: runtime.clock.now(),
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
        input: JSON.stringify({ greeting: 'hello' }),
      };

      await cache.set('key-2', result);
      const raw = await store.get('key-2');

      expect(typeof raw).toBe('string');
      expect(JSON.parse(raw!)).toMatchObject({
        ...result,
        status: 'completed',
      });
      const cachedResult = await cache.get('key-2');
      expect(cachedResult?.input).toBe(result.input);
    });

    it('preserves completed results whose value is undefined', async () => {
      const result: CachedToolResult = {
        result: undefined,
        toolName: 'no-output-tool',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      };

      await cache.set('undefined-result', result);

      expect(await cache.get('undefined-result')).toMatchObject({
        ...result,
        status: 'completed',
      });
      expect(await cache.getState!('undefined-result')).toMatchObject({
        ...result,
        status: 'completed',
      });
    });
  });

  describe('TTL expiration', () => {
    it('returns undefined for an expired entry', async () => {
      let clock = 1_000;
      const expiringCache = createToolResultCache({ store, now: () => clock });
      const result: CachedToolResult = {
        result: 'stale',
        toolName: 'old-tool',
        executedAt: 10_000_000,
        ttl: 60_000, // 1 minute TTL
      };

      await expiringCache.set('expired-key', result);
      clock = 61_001;
      const retrieved = await expiringCache.get('expired-key');

      expect(retrieved).toBeUndefined();
    });

    it('returns the entry when TTL has not expired', async () => {
      const result: CachedToolResult = {
        result: 'fresh',
        toolName: 'new-tool',
        executedAt: runtime.clock.now() - 10_000, // 10 seconds ago
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
        now: runtime.clock.now,
      });

      const result: CachedToolResult = {
        result: 'namespaced',
        toolName: 'tool',
        executedAt: runtime.clock.now(),
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
        executedAt: runtime.clock.now(),
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
        executedAt: runtime.clock.now(),
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
      await cache.claimStarted('started-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      expect(await cache.get('started-key')).toBeUndefined();
      expect(await cache.getState!('started-key')).toEqual({
        status: 'started',
        toolName: 'charge-card',
        startedAt: expect.any(Number),
        ttl: 60_000,
      });
    });

    it('returns an existing entry when claiming an already completed key', async () => {
      const completed: CachedToolResult = {
        result: { ok: true },
        toolName: 'charge-card',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      };
      await cache.set('completed-key', completed);

      expect(
        await cache.claimStarted!('completed-key', {
          status: 'started',
          toolName: 'charge-card',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
        }),
      ).toMatchObject({ outcome: 'existing', entry: { ...completed, status: 'completed' } });
    });

    it('serializes concurrent claims for the same key within a cache instance', async () => {
      const firstClaim = cache.claimStarted!('racing-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });
      const secondClaim = cache.claimStarted!('racing-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      const results = await Promise.all([firstClaim, secondClaim]);

      expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'existing')).toHaveLength(1);
      expect(await cache.getState!('racing-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'charge-card',
        }),
      );
    });

    it('continues serializing claims after an earlier claim fails', async () => {
      const map = new Map<string, string>();
      let writes = 0;
      const failingCache = createToolResultCache({
        store: {
          get: async (key: string) => map.get(key) ?? null,
          set: async (key: string, value: string) => {
            writes++;
            if (writes === 1) {
              throw new Error('write failed');
            }
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          list: async (prefix: string) =>
            [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
        },
        defaultTTL: 60_000,
        now: runtime.clock.now,
      });

      const firstClaim = failingCache.claimStarted!('recover-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      const secondClaim = failingCache.claimStarted!('recover-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      await expect(firstClaim).resolves.toBe('write failed');
      await expect(secondClaim).resolves.toEqual({ outcome: 'claimed' });
      expect(await failingCache.getState!('recover-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'charge-card',
        }),
      );
    });

    it('preserves stale started state as an unknown outcome', async () => {
      await cache.claimStarted('expired-started-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now() - 120_000,
        ttl: 60_000,
      });

      expect(await cache.getState('expired-started-key')).toEqual(
        expect.objectContaining({ status: 'started', toolName: 'charge-card' }),
      );
      expect(await store.get('expired-started-key')).not.toBeNull();
    });

    it('reads legacy completed entries without a status field', async () => {
      await store.set(
        'legacy-key',
        JSON.stringify({
          result: 'legacy-result',
          toolName: 'legacy-tool',
          executedAt: runtime.clock.now(),
          ttl: 60_000,
        }),
      );

      expect(await cache.get('legacy-key')).toEqual({
        status: 'completed',
        result: 'legacy-result',
        toolName: 'legacy-tool',
        executedAt: expect.any(Number),
        ttl: 60_000,
      });
    });

    it('reads legacy started entries without an attempt fence', async () => {
      await store.set(
        'legacy-started-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
        }),
      );

      expect(await cache.get('legacy-started-key')).toBeUndefined();
      expect(await cache.getState('legacy-started-key')).toEqual({
        status: 'started',
        toolName: 'legacy-charge',
        startedAt: 1_000,
        ttl: 60_000,
      });
    });

    it('replaces only matching legacy started entries with a new fenced attempt', async () => {
      await store.set(
        'legacy-started-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
        }),
      );

      await expect(
        cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 999 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).resolves.toBe(false);
      await expect(
        cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
          },
          2_000,
        ),
      ).resolves.toBe(false);
      await expect(
        cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).resolves.toBe(true);

      expect(await cache.getState('legacy-started-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 2_000,
          attemptId: 'replacement-attempt',
        }),
      );
    });

    it('does not replace fenced or actively leased entries through the legacy path', async () => {
      await cache.claimStarted('fenced-key', {
        status: 'started',
        toolName: 'charge',
        startedAt: 1_000,
        ttl: 60_000,
        attemptId: 'current-attempt',
      });
      await store.set(
        'active-legacy-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
          leaseExpiresAt: 3_000,
        }),
      );

      await expect(
        cache.replaceLegacyStarted(
          'fenced-key',
          { toolName: 'charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).resolves.toBe(false);
      await expect(
        cache.replaceLegacyStarted(
          'active-legacy-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).resolves.toBe(false);

      expect(await cache.getState('fenced-key')).toEqual(
        expect.objectContaining({ attemptId: 'current-attempt' }),
      );
      expect(await cache.getState('active-legacy-key')).toEqual(
        expect.objectContaining({ leaseExpiresAt: 3_000 }),
      );
    });

    it('deletes malformed entries on read', async () => {
      await store.set('malformed-key', JSON.stringify({ status: 'completed' }));

      expect(await cache.getState!('malformed-key')).toBeUndefined();
      expect(await store.get('malformed-key')).toBeNull();
    });

    it('deletes non-object entries on read', async () => {
      await store.set('array-key', JSON.stringify([]));

      expect(await cache.getState!('array-key')).toBeUndefined();
      expect(await store.get('array-key')).toBeNull();
    });

    it('deletes invalid JSON entries on read', async () => {
      await store.set('invalid-json-key', '{');

      expect(await cache.getState!('invalid-json-key')).toBeUndefined();
      expect(await store.get('invalid-json-key')).toBeNull();
    });
  });

  describe('defaultTTL', () => {
    it('returns an entry whose TTL has not yet expired', async () => {
      const defaultCache = createToolResultCache({ store, now: runtime.clock.now });
      const result: CachedToolResult = {
        result: 'still-valid',
        toolName: 'tool',
        executedAt: runtime.clock.now() - 200_000, // 200 seconds ago, within 300s default
        ttl: 300_000,
      };

      await defaultCache.set('ttl-valid', result);
      const retrieved = await defaultCache.get('ttl-valid');
      expect(retrieved).toMatchObject(result);
    });

    it('expires an entry from its cache-clock insertion timestamp', async () => {
      let clock = 1_000;
      const defaultCache = createToolResultCache({ store, now: () => clock });
      const result: CachedToolResult = {
        result: 'expired',
        toolName: 'tool',
        executedAt: 10_000_000,
        ttl: 300_000,
      };

      await defaultCache.set('ttl-expired', result);
      clock = 301_001;
      const retrieved = await defaultCache.get('ttl-expired');
      expect(retrieved).toBeUndefined();
    });
  });

  it('shares claim fencing across independent cache instances using one store', async () => {
    const first = createToolResultCache({ store, now: runtime.clock.now });
    const second = createToolResultCache({ store, now: runtime.clock.now });
    const execution = {
      status: 'started' as const,
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'attempt-1',
    };
    const [left, right] = await Promise.all([
      first.claimStarted!('shared', execution),
      second.claimStarted!('shared', { ...execution, attemptId: 'attempt-2' }),
    ]);
    expect([left.outcome, right.outcome].filter((outcome) => outcome === 'claimed')).toHaveLength(
      1,
    );
  });

  it('shares claim fencing by resolved backing key across namespaces', async () => {
    const namespaced = createToolResultCache({ store, namespace: 'a', now: runtime.clock.now });
    const unnamespaced = createToolResultCache({ store, now: runtime.clock.now });
    const execution = {
      status: 'started' as const,
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
    };

    const [left, right] = await Promise.all([
      namespaced.claimStarted!('x', { ...execution, attemptId: 'namespaced' }),
      unnamespaced.claimStarted!('a:x', { ...execution, attemptId: 'unnamespaced' }),
    ]);

    expect([left.outcome, right.outcome].filter((outcome) => outcome === 'claimed')).toHaveLength(
      1,
    );
    expect(await store.get('a:x')).toBeString();
  });

  it('renews and completes only for the current fencing token', async () => {
    await cache.claimStarted!('fenced', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'current',
      absoluteDeadline: runtime.clock.now() + 60_000,
    });
    expect(
      await cache.renewStarted!(
        'fenced',
        'stale',
        runtime.clock.now() + 30_000,
        runtime.clock.now(),
      ),
    ).toBe(false);
    expect(
      await cache.renewStarted!(
        'fenced',
        'current',
        runtime.clock.now() + 30_000,
        runtime.clock.now(),
      ),
    ).toBe(true);
    expect(
      await cache.completeStarted!('fenced', 'stale', {
        result: 'late',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).toBe(false);
    expect(
      await cache.completeStarted!('fenced', 'current', {
        result: 'ok',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).toBe(true);
    const completed = await cache.get('fenced');
    expect(completed?.result).toBe('ok');
  });

  it('uses the configured cache clock as the default completion observation time', async () => {
    const clockedCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
      now: () => 1_000,
    });
    await clockedCache.claimStarted('clocked-completion', {
      status: 'started',
      toolName: 'charge',
      startedAt: 500,
      ttl: 60_000,
      attemptId: 'clocked-attempt',
      absoluteDeadline: 1_500,
    });

    await expect(
      clockedCache.completeStarted('clocked-completion', 'clocked-attempt', {
        result: 'ok',
        toolName: 'charge',
        executedAt: 1_000,
        ttl: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(clockedCache.get('clocked-completion')).resolves.toMatchObject({
      status: 'completed',
      result: 'ok',
    });
  });

  it('enforces absolute deadlines and unknown-attempt replacement fences', async () => {
    await cache.claimStarted('expired-fence', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now() - 100,
      ttl: 60_000,
      attemptId: 'expired-attempt',
      leaseExpiresAt: runtime.clock.now() - 50,
      absoluteDeadline: runtime.clock.now() - 1,
    });
    await expect(
      cache.renewStarted(
        'expired-fence',
        'expired-attempt',
        runtime.clock.now() + 100,
        runtime.clock.now(),
      ),
    ).resolves.toBe(false);
    await expect(
      cache.completeStarted('expired-fence', 'expired-attempt', {
        result: 'late',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).resolves.toBe(false);

    await cache.claimStarted('bounded-renewal', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'bounded-attempt',
      absoluteDeadline: runtime.clock.now() + 10_000,
    });
    await expect(
      cache.renewStarted(
        'bounded-renewal',
        'bounded-attempt',
        runtime.clock.now() + 20_000,
        runtime.clock.now(),
      ),
    ).resolves.toBe(true);
    const boundedRenewal = await cache.getState('bounded-renewal');
    expect(
      boundedRenewal?.status === 'started' ? boundedRenewal.leaseExpiresAt : undefined,
    ).toBeLessThanOrEqual(runtime.clock.now() + 10_000);

    await expect(cache.deleteStarted('bounded-renewal', 'stale-attempt')).resolves.toBe(false);
    await expect(
      cache.replaceUnknownStarted(
        'bounded-renewal',
        'bounded-attempt',
        {
          status: 'started',
          toolName: 'charge',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
          attemptId: 'replacement-attempt',
        },
        runtime.clock.now(),
      ),
    ).resolves.toBe(false);
    await expect(cache.deleteStarted('bounded-renewal', 'bounded-attempt')).resolves.toBe(true);
    await expect(cache.getState('bounded-renewal')).resolves.toBeUndefined();

    await expect(
      cache.replaceUnknownStarted(
        'bounded-renewal',
        'stale-attempt',
        {
          status: 'started',
          toolName: 'charge',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
          attemptId: 'replacement',
        },
        runtime.clock.now(),
      ),
    ).resolves.toBe(false);
  });
});
