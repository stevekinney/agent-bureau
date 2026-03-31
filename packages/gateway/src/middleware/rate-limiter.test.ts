import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { KeyValueStore } from 'storage';
import { createMemoryKeyValueStore } from 'storage';

import { errorHandler } from './error-handler';
import { createRateLimiter } from './rate-limiter';
import { requestIdentifier } from './request-identifier';

function createApp(options?: { limit?: number; store?: KeyValueStore; windowMs?: number }) {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.use('*', createRateLimiter(options));
  app.get('/test', (c) => c.json({ ok: true }));
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
    const store = createMemoryKeyValueStore();
    const headers = { 'x-auth-principal': 'api-key:test-key' };

    const firstApp = createApp({ limit: 1, store, windowMs: 60_000 });
    const firstResponse = await firstApp.request('/test', { headers });
    expect(firstResponse.status).toBe(200);

    const secondApp = createApp({ limit: 1, store, windowMs: 60_000 });
    const secondResponse = await secondApp.request('/test', { headers });
    expect(secondResponse.status).toBe(429);
  });

  it('serializes concurrent store-backed updates for the same principal', async () => {
    const backingStore = createMemoryKeyValueStore();
    const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
    const store: KeyValueStore = {
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
});
