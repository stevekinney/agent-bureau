import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';

import { createApiKeyStore } from '../keys/create-api-key-store';
import { createBunAdapter, handleWsUpgrade } from './bun-adapter';

/**
 * A minimal fake shaped like the subset of Bun's `Server` the adapter
 * touches (`stop()`), with a controllable `stop()` so tests can observe
 * that `ServerHandle.stop()` doesn't resolve until the underlying
 * `Bun.serve()` server has actually finished stopping.
 */
function createFakeBunServer() {
  let releaseStop: (() => void) | undefined;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let stopCalled = false;

  return {
    server: {
      stop: () => {
        stopCalled = true;
        return stopGate;
      },
    },
    releaseStop: () => releaseStop?.(),
    wasStopCalled: () => stopCalled,
  };
}

/** A Hono-shaped stub — the adapter never calls anything but `fetch`. */
function fakeApp(): Hono {
  return { fetch: () => new Response('ok') } as unknown as Hono;
}

/** A no-op upgrade function — always "succeeds" so we can test auth in isolation. */
function acceptUpgrade(_request: Request): boolean {
  return true;
}

/** A failing upgrade function — simulates Bun being unable to upgrade. */
function rejectUpgrade(_request: Request): boolean {
  return false;
}

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('handleWsUpgrade — no auth configured', () => {
  it('accepts the upgrade when no authToken and no authenticate function', async () => {
    const request = makeRequest('http://localhost/ws');
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {});
    // acceptUpgrade returns true → handleWsUpgrade returns undefined (accepted)
    expect(result).toBeUndefined();
  });
});

describe('handleWsUpgrade — static authToken only (backwards compatibility)', () => {
  it('rejects upgrade with no token when authToken is set', async () => {
    const request = makeRequest('http://localhost/ws');
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      authToken: 'secret',
    });
    expect(result?.status).toBe(401);
  });

  it('rejects upgrade with wrong token', async () => {
    const request = makeRequest('http://localhost/ws', { authorization: 'Bearer wrong' });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      authToken: 'secret',
    });
    expect(result?.status).toBe(401);
  });

  it('accepts upgrade with correct Bearer token', async () => {
    const request = makeRequest('http://localhost/ws', { authorization: 'Bearer secret' });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      authToken: 'secret',
    });
    expect(result).toBeUndefined();
  });

  it('accepts upgrade with correct query-string token', async () => {
    const request = makeRequest('http://localhost/ws?token=secret');
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      authToken: 'secret',
    });
    expect(result).toBeUndefined();
  });
});

describe('handleWsUpgrade — managed API key store (the fixed bug path)', () => {
  it('rejects WebSocket upgrade with no credentials when apiKeyStore is active but authToken is absent', async () => {
    // This is the regression: before the fix, an unauthenticated request would
    // bypass auth and receive 400 (upgrade failed) instead of 401.
    const kv = textValueStore(new MemoryStorage());
    const store = createApiKeyStore(kv);
    const authenticate = async (request: Request): Promise<boolean> => {
      const authHeader = request.headers.get('authorization') ?? '';
      const headerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
      const url = new URL(request.url);
      const queryToken = url.searchParams.get('token') ?? undefined;
      const token = headerToken ?? queryToken;
      if (!token) return false;
      if (token.startsWith('ab_live_')) {
        const key = await store.verify(token);
        return key !== null;
      }
      return false;
    };

    const request = makeRequest('http://localhost/ws');
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, { authenticate });
    // Must be 401 — not 400 or undefined (accepted)
    expect(result?.status).toBe(401);
  });

  it('rejects WebSocket upgrade with an invalid managed API key', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createApiKeyStore(kv);
    const authenticate = async (request: Request): Promise<boolean> => {
      const authHeader = request.headers.get('authorization') ?? '';
      const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
      if (!token) return false;
      if (token.startsWith('ab_live_')) {
        const key = await store.verify(token);
        return key !== null;
      }
      return false;
    };

    const request = makeRequest('http://localhost/ws', {
      authorization:
        'Bearer ab_live_0000000000000000000000000000000000000000000000000000000000000000',
    });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, { authenticate });
    expect(result?.status).toBe(401);
  });

  it('accepts WebSocket upgrade with a valid managed API key', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createApiKeyStore(kv);
    const { plaintext } = await store.create({ name: 'ws-key' });

    const authenticate = async (request: Request): Promise<boolean> => {
      const authHeader = request.headers.get('authorization') ?? '';
      const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
      if (!token) return false;
      if (token.startsWith('ab_live_')) {
        const key = await store.verify(token);
        return key !== null;
      }
      return false;
    };

    const request = makeRequest('http://localhost/ws', {
      authorization: `Bearer ${plaintext}`,
    });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, { authenticate });
    // Valid key → upgrade accepted → result is undefined
    expect(result).toBeUndefined();
  });
});

describe('handleWsUpgrade — origin check', () => {
  it('rejects upgrade from a disallowed origin', async () => {
    const request = makeRequest('http://localhost/ws', { origin: 'https://evil.example.com' });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      allowedOrigins: ['https://trusted.example.com'],
    });
    expect(result?.status).toBe(403);
  });

  it('accepts upgrade from an allowed origin', async () => {
    const request = makeRequest('http://localhost/ws', {
      origin: 'https://trusted.example.com',
    });
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, acceptUpgrade, {
      allowedOrigins: ['https://trusted.example.com'],
    });
    expect(result).toBeUndefined();
  });
});

describe('handleWsUpgrade — upgrade failure', () => {
  it('returns 400 when server.upgrade returns false', async () => {
    const request = makeRequest('http://localhost/ws');
    const url = new URL(request.url);
    const result = await handleWsUpgrade(request, url, rejectUpgrade, {});
    expect(result?.status).toBe(400);
  });
});

describe('createBunAdapter — stop()', () => {
  const originalServe = Bun.serve;

  afterEach(() => {
    Bun.serve = originalServe;
  });

  it("does not resolve until Bun.serve()'s own stop() promise resolves (no wsHandler)", async () => {
    const fake = createFakeBunServer();
    Bun.serve = (() => fake.server) as unknown as typeof Bun.serve;

    const adapter = createBunAdapter();
    const handle = await adapter.serve(fakeApp(), { port: 0 });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(fake.wasStopCalled()).toBe(true);
    expect(resolved).toBe(false);

    fake.releaseStop();
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it("does not resolve until Bun.serve()'s own stop() promise resolves (with wsHandler)", async () => {
    const fake = createFakeBunServer();
    Bun.serve = (() => fake.server) as unknown as typeof Bun.serve;

    const adapter = createBunAdapter();
    const wsHandler = {
      dispose: () => {},
      open: () => {},
      message: () => {},
      close: () => {},
    };
    const handle = await adapter.serve(fakeApp(), { port: 0, wsHandler });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(fake.wasStopCalled()).toBe(true);
    expect(resolved).toBe(false);

    fake.releaseStop();
    await stopPromise;
    expect(resolved).toBe(true);
  });
});
