import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import { createApiKeyStore } from '../keys/create-api-key-store';
import { handleWsUpgrade } from './bun-adapter';

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
