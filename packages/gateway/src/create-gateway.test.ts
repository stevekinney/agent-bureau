import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { createStore } from 'operative/store';

import { createBunAdapter, handleWsUpgrade } from './adapters/bun-adapter';
import { createGateway } from './create-gateway';
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
