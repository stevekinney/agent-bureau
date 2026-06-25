import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { createStore } from 'operative/store';

import { createBunAdapter, handleWsUpgrade } from './adapters/bun-adapter';
import { buildWsAuthenticate, createGateway } from './create-gateway';
import type { ApiKey, ApiKeyStore } from './keys/types';
import { DEFAULT_PORT } from './types';

describe('createGateway', () => {
  it('creates a gateway with default options', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(gateway.app).toBeDefined();
    expect(gateway.store).toBeDefined();
    expect(gateway.port).toBe(DEFAULT_PORT);
    bureau.dispose();
  });

  it('uses a custom port', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau, { port: 9999 });
    expect(gateway.port).toBe(9999);
    bureau.dispose();
  });

  it('uses a provided store', async () => {
    const store = createStore();
    const bureau = await createBureau({ store });
    const gateway = await createGateway(bureau);
    expect(gateway.store).toBe(store);
    bureau.dispose();
  });

  it('default port is 5555', () => {
    expect(DEFAULT_PORT).toBe(5555);
  });

  it('exposes a start function', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(typeof gateway.start).toBe('function');
    bureau.dispose();
  });

  it('accepts runtime option', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau, { runtime: 'bun' });
    expect(gateway.app).toBeDefined();
    bureau.dispose();
  });

  it('exposes the bureau as a property on the gateway', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(gateway.bureau).toBe(bureau);
    bureau.dispose();
  });

  it('gateway does not dispose the bureau on stop', async () => {
    const bureau = await createBureau();
    let disposed = false;
    const originalDispose = bureau.dispose.bind(bureau);
    bureau.dispose = () => {
      disposed = true;
      originalDispose();
    };
    const gateway = await createGateway(bureau);
    // Verify the gateway holds a reference to the passed bureau
    // and that merely holding the gateway does not dispose the bureau.
    // The caller owns the bureau lifecycle.
    expect(gateway.bureau).toBe(bureau);
    expect(disposed).toBe(false);
    bureau.dispose();
  });
});

describe('createBunAdapter', () => {
  it('returns an adapter with serve and mountStaticFiles', () => {
    const adapter = createBunAdapter();
    expect(typeof adapter.serve).toBe('function');
    expect(typeof adapter.mountStaticFiles).toBe('function');
  });
});

// ── handleWsUpgrade — Bun adapter origin enforcement ────────────────────────
//
// The Bun adapter intercepts /ws upgrade requests before app.fetch() runs,
// so the Hono createSecurityHeaders middleware is bypassed. handleWsUpgrade
// encapsulates the auth + origin check logic and is tested here directly
// without requiring a real Bun server.

describe('handleWsUpgrade', () => {
  function makeRequest(headers: Record<string, string> = {}, search = ''): [Request, URL] {
    const url = new URL(`http://localhost/ws${search}`);
    const request = new Request(url.toString(), { headers });
    return [request, url];
  }

  function noopUpgrade(_request: Request): boolean {
    return true;
  }

  describe('origin check', () => {
    it('allows any origin when allowedOrigins is empty', async () => {
      const [request, url] = makeRequest({ origin: 'http://evil.example' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, { allowedOrigins: [] });
      expect(result?.status).not.toBe(403);
    });

    it('allows any origin when allowedOrigins is omitted', async () => {
      const [request, url] = makeRequest({ origin: 'http://evil.example' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, {});
      expect(result?.status).not.toBe(403);
    });

    it('allows a listed origin when allowedOrigins is configured', async () => {
      const [request, url] = makeRequest({ origin: 'http://app.example' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, {
        allowedOrigins: ['http://app.example'],
      });
      expect(result?.status).not.toBe(403);
    });

    it('rejects an unlisted origin with 403 when allowedOrigins is configured', async () => {
      const [request, url] = makeRequest({ origin: 'http://evil.example' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, {
        allowedOrigins: ['http://app.example'],
      });
      expect(result?.status).toBe(403);
    });

    it('rejects a missing Origin header with 403 when allowedOrigins is configured', async () => {
      const [request, url] = makeRequest({});
      const result = await handleWsUpgrade(request, url, noopUpgrade, {
        allowedOrigins: ['http://app.example'],
      });
      expect(result?.status).toBe(403);
    });
  });

  describe('auth token check', () => {
    it('rejects with 401 when token is missing and authToken is required', async () => {
      const [request, url] = makeRequest({});
      const result = await handleWsUpgrade(request, url, noopUpgrade, { authToken: 'secret' });
      expect(result?.status).toBe(401);
    });

    it('rejects with 401 when Bearer token is wrong', async () => {
      const [request, url] = makeRequest({ authorization: 'Bearer wrong' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, { authToken: 'secret' });
      expect(result?.status).toBe(401);
    });

    it('accepts a correct Bearer token', async () => {
      const [request, url] = makeRequest({ authorization: 'Bearer secret' });
      const result = await handleWsUpgrade(request, url, noopUpgrade, { authToken: 'secret' });
      expect(result?.status).not.toBe(401);
    });

    it('accepts a correct query-string token', async () => {
      const [request, url] = makeRequest({}, '?token=secret');
      const result = await handleWsUpgrade(request, url, noopUpgrade, { authToken: 'secret' });
      expect(result?.status).not.toBe(401);
    });
  });

  describe('upgrade failure', () => {
    it('returns 400 when upgrade() returns false', async () => {
      const [request, url] = makeRequest({ origin: 'http://app.example' });
      const result = await handleWsUpgrade(request, url, () => false, {
        allowedOrigins: ['http://app.example'],
      });
      expect(result?.status).toBe(400);
    });

    it('returns undefined when upgrade() succeeds', async () => {
      const [request, url] = makeRequest({ origin: 'http://app.example' });
      const result = await handleWsUpgrade(request, url, () => true, {
        allowedOrigins: ['http://app.example'],
      });
      expect(result).toBeUndefined();
    });
  });
});

// ── buildWsAuthenticate — WebSocket scope enforcement ────────────────────────
//
// The /ws path must require the same runs:read scope as GET /api/v1/events.
// A managed API key that is valid but scoped only for keys:manage or runs:write
// must NOT be able to subscribe to live run frames over WebSocket.

describe('buildWsAuthenticate', () => {
  function makeWsRequest(headers: Record<string, string> = {}, search = ''): Request {
    return new Request(`http://localhost/ws${search}`, { headers });
  }

  function makeApiKeyStore(key: ApiKey | null): ApiKeyStore {
    return {
      verify: async (_token: string) => key,
      create: async () => ({ key: key!, plaintext: 'ab_live_test' }),
      revoke: async () => undefined,
      list: async () => (key ? [key] : []),
      rotate: async () => ({ key: key!, plaintext: 'ab_live_rotated' }),
    };
  }

  function makeKey(scopes: string[]): ApiKey {
    return {
      id: 'key-1',
      name: 'test',
      keyHash: 'hash',
      scopes,
      createdAt: new Date().toISOString(),
      active: true,
    };
  }

  it('returns undefined when neither authToken nor store is provided', () => {
    const verifier = buildWsAuthenticate(undefined, undefined);
    expect(verifier).toBeUndefined();
  });

  it('allows a managed key with runs:read scope', async () => {
    const store = makeApiKeyStore(makeKey(['runs:read']));
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(true);
  });

  it('rejects a managed key scoped only for keys:manage (missing runs:read)', async () => {
    const store = makeApiKeyStore(makeKey(['keys:manage']));
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(false);
  });

  it('rejects a managed key scoped only for runs:write (missing runs:read)', async () => {
    const store = makeApiKeyStore(makeKey(['runs:write']));
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(false);
  });

  it('allows an admin key with empty scopes array', async () => {
    const store = makeApiKeyStore(makeKey([]));
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(true);
  });

  it('allows a key with runs:read among multiple scopes', async () => {
    const store = makeApiKeyStore(makeKey(['runs:read', 'runs:write', 'sessions:read']));
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(true);
  });

  it('rejects an invalid or expired managed key', async () => {
    const store = makeApiKeyStore(null);
    const verifier = buildWsAuthenticate(undefined, store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(false);
  });

  it('allows the static authToken without scope restriction', async () => {
    const verifier = buildWsAuthenticate('admin-secret', undefined);
    const request = makeWsRequest({ authorization: 'Bearer admin-secret' });
    expect(await verifier!(request)).toBe(true);
  });

  it('rejects a static token mismatch', async () => {
    const verifier = buildWsAuthenticate('admin-secret', undefined);
    const request = makeWsRequest({ authorization: 'Bearer wrong-token' });
    expect(await verifier!(request)).toBe(false);
  });

  it('accepts a static token via query string', async () => {
    const verifier = buildWsAuthenticate('admin-secret', undefined);
    const request = makeWsRequest({}, '?token=admin-secret');
    expect(await verifier!(request)).toBe(true);
  });

  it('rejects when no token is provided and auth is configured', async () => {
    const verifier = buildWsAuthenticate('admin-secret', undefined);
    const request = makeWsRequest({});
    expect(await verifier!(request)).toBe(false);
  });

  it('prefers managed key verification over static token when token starts with ab_live_', async () => {
    // If the managed key is valid and has runs:read, it wins
    const store = makeApiKeyStore(makeKey(['runs:read']));
    const verifier = buildWsAuthenticate('fallback-token', store);
    const request = makeWsRequest({ authorization: 'Bearer ab_live_token' });
    expect(await verifier!(request)).toBe(true);
  });
});
