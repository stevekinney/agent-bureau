import { MemoryStorage, type TextValueStore, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { errorHandler } from './error-handler';
import { createRateLimiter } from './rate-limiter';
import { requestIdentifier } from './request-identifier';

function createApp(options?: {
  beforeRecordHookIdempotencyReceipt?: () => Promise<void>;
  hasHookIdempotencyReceipt?: (principal: string, idempotencyKey: string) => boolean;
  limit?: number;
  now?: () => number;
  recordHookIdempotencyReceipt?: (principal: string, idempotencyKey: string) => void;
  store?: TextValueStore;
  windowMs?: number;
}) {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.use('*', createRateLimiter(options));
  app.get('/test', (c) => c.json({ ok: true }));
  app.post('/hooks/*', async (context) => {
    await options?.beforeRecordHookIdempotencyReceipt?.();
    const principal = context.req.header('x-api-key-id');
    const idempotencyKey = context.req.header('Idempotency-Key');
    if (principal && idempotencyKey) {
      options?.recordHookIdempotencyReceipt?.(principal, idempotencyKey);
    }
    return context.json({ ok: true });
  });
  app.onError(errorHandler);
  return app;
}

describe('rate limiter', () => {
  it('allows requests within the limit', async () => {
    const app = createApp({ limit: 5, windowMs: 60_000 });
    const response = await app.request('/test', {
      headers: { 'x-api-key-id': 'test-key' },
    });
    expect(response.status).toBe(200);
  });

  it('sets rate limit headers', async () => {
    const app = createApp({ limit: 10, windowMs: 60_000 });
    const response = await app.request('/test', {
      headers: { 'x-api-key-id': 'test-key' },
    });
    expect(response.headers.get('x-ratelimit-limit')).toBe('10');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('9');
    expect(response.headers.get('x-ratelimit-reset')).toBeString();
  });

  it('returns 429 when limit is exceeded', async () => {
    const app = createApp({ limit: 3, windowMs: 60_000 });
    const headers = { 'x-api-key-id': 'burst-key' };

    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      const response = await app.request('/test', { headers });
      expect(response.status).toBe(200);
    }

    // Next request should be rate limited
    const response = await app.request('/test', { headers });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeString();
  });

  it('does not charge repeated hook idempotency keys against the rate limit', async () => {
    const receipts = new Set<string>();
    const app = createApp({
      limit: 1,
      windowMs: 60_000,
      hasHookIdempotencyReceipt: (principal, key) => receipts.has(`${principal}:${key}`),
      recordHookIdempotencyReceipt: (principal, key) => receipts.add(`${principal}:${key}`),
    });
    const headers = {
      'Idempotency-Key': 'same-run',
      'x-api-key-id': 'retrying-hook-client',
    };

    const firstResponse = await app.request('/hooks/example', { headers, method: 'POST' });
    const replayResponse = await app.request('/hooks/example', { headers, method: 'POST' });
    const distinctResponse = await app.request('/hooks/example', {
      headers: { ...headers, 'Idempotency-Key': 'different-run' },
      method: 'POST',
    });

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(distinctResponse.status).toBe(429);
  });

  it('serializes concurrent keyed hooks until the first receipt is recorded', async () => {
    const receipts = new Set<string>();
    let releaseFirstRequest!: () => void;
    const firstRequestMayFinish = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let handlerCalls = 0;
    const app = createApp({
      limit: 1,
      windowMs: 60_000,
      beforeRecordHookIdempotencyReceipt: async () => {
        handlerCalls += 1;
        if (handlerCalls === 1) await firstRequestMayFinish;
      },
      hasHookIdempotencyReceipt: (principal, key) => receipts.has(`${principal}:${key}`),
      recordHookIdempotencyReceipt: (principal, key) => receipts.add(`${principal}:${key}`),
    });
    const request = () =>
      app.request('/hooks/example', {
        headers: {
          'Idempotency-Key': 'concurrent-run',
          'x-api-key-id': 'concurrent-hook-client',
        },
        method: 'POST',
      });

    const firstResponsePromise = request();
    await Promise.resolve();
    const secondResponsePromise = request();
    releaseFirstRequest();

    const responses = await Promise.all([firstResponsePromise, secondResponsePromise]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  it('does not exempt a malformed hook request without a recorded receipt', async () => {
    const app = createApp({
      limit: 1,
      windowMs: 60_000,
      hasHookIdempotencyReceipt: () => false,
    });
    const headers = {
      'Idempotency-Key': 'malformed-key',
      'x-api-key-id': 'malformed-hook-client',
    };

    const firstResponse = await app.request('/hooks/example', { headers, method: 'POST' });
    const retryResponse = await app.request('/hooks/example', { headers, method: 'POST' });

    expect(firstResponse.status).toBe(200);
    expect(retryResponse.status).toBe(429);
  });

  it('tracks keys independently', async () => {
    const app = createApp({ limit: 2, windowMs: 60_000 });

    // Exhaust limit for key-a
    await app.request('/test', { headers: { 'x-api-key-id': 'key-a' } });
    await app.request('/test', { headers: { 'x-api-key-id': 'key-a' } });

    const blockedResponse = await app.request('/test', {
      headers: { 'x-api-key-id': 'key-a' },
    });
    expect(blockedResponse.status).toBe(429);

    // key-b should still be allowed
    const allowedResponse = await app.request('/test', {
      headers: { 'x-api-key-id': 'key-b' },
    });
    expect(allowedResponse.status).toBe(200);
  });

  it('skips rate limiting when no key id is present', async () => {
    const app = createApp({ limit: 1, windowMs: 60_000 });

    // Multiple requests without a key id should all pass
    const response1 = await app.request('/test');
    expect(response1.status).toBe(200);

    const response2 = await app.request('/test');
    expect(response2.status).toBe(200);
  });

  it('uses default limit of 60 requests per 60s', async () => {
    const app = createApp();
    const response = await app.request('/test', {
      headers: { 'x-api-key-id': 'default-key' },
    });
    expect(response.headers.get('x-ratelimit-limit')).toBe('60');
  });

  it('limits static-token principals via x-auth-principal', async () => {
    const app = createApp({ limit: 1, windowMs: 60_000 });
    const headers = { 'x-auth-principal': 'static-token' };

    const firstResponse = await app.request('/test', { headers });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await app.request('/test', { headers });
    expect(secondResponse.status).toBe(429);
  });

  it('persists limits across middleware instances when a store is provided', async () => {
    const store = textValueStore(new MemoryStorage());
    const headers = { 'x-auth-principal': 'api-key:test-key' };

    const firstApp = createApp({ limit: 1, store, windowMs: 60_000 });
    const firstResponse = await firstApp.request('/test', { headers });
    expect(firstResponse.status).toBe(200);

    const secondApp = createApp({ limit: 1, store, windowMs: 60_000 });
    const secondResponse = await secondApp.request('/test', { headers });
    expect(secondResponse.status).toBe(429);
  });

  it('serializes concurrent store-backed updates for the same principal', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    const delay = () => Promise.resolve();
    const store: TextValueStore = {
      async get(key) {
        await delay();
        return backingStore.get(key);
      },
      async set(key, value) {
        await delay();
        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
      has(key) {
        return backingStore.has(key);
      },
      deletePrefix(prefix) {
        return backingStore.deletePrefix(prefix);
      },
      close() {
        return backingStore.close();
      },
    };

    const app = createApp({ limit: 1, store, windowMs: 60_000 });
    const headers = { 'x-auth-principal': 'api-key:concurrent-key' };

    const responses = await Promise.all([
      app.request('/test', { headers }),
      app.request('/test', { headers }),
    ]);
    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);

    expect(statuses).toEqual([200, 429]);
  });

  it('persists pruned timestamps before returning a limited decision', async () => {
    const store = textValueStore(new MemoryStorage());
    const headers = { 'x-auth-principal': 'api-key:pruned-key' };
    const storageKey = 'gateway:rate-limit:api-key:pruned-key';
    const now = 1_700_000_000_000;

    await store.set(
      storageKey,
      JSON.stringify({
        timestamps: [now - 5_000, now - 100],
      }),
    );

    const app = createApp({ limit: 1, now: () => now, store, windowMs: 1_000 });
    const response = await app.request('/test', { headers });

    expect(response.status).toBe(429);

    const stored = JSON.parse((await store.get(storageKey)) ?? '{"timestamps":[]}') as {
      timestamps: number[];
    };
    expect(stored.timestamps).toHaveLength(1);
    expect(stored.timestamps[0]!).toBeGreaterThan(now - 1_000);
  });
});
