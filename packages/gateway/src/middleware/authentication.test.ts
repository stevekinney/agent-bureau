import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { createApiKeyStore } from '../keys/create-api-key-store';
import type { ApiKeyStore } from '../keys/types';
import { createAuthentication } from './authentication';
import { errorHandler } from './error-handler';
import { requestIdentifier } from './request-identifier';

function createApp(authToken: string | undefined, apiKeyStore?: ApiKeyStore) {
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.use('*', createAuthentication(authToken, apiKeyStore));
  app.get('/protected', (c) => c.json({ ok: true }));
  app.get('/api/v1/events', (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

describe('authentication', () => {
  it('passes all requests when no token is configured', async () => {
    const app = createApp(undefined);
    const response = await app.request('/protected');
    expect(response.status).toBe(200);
  });

  it('rejects requests without authorization header', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected');
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Missing authorization header');
  });

  it('rejects requests with wrong token', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Invalid authorization token');
  });

  it('rejects requests with wrong scheme', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Basic secret-token' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Invalid authorization token');
  });

  it('passes requests with correct bearer token', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('accepts case-insensitive bearer scheme', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected', {
      headers: { authorization: 'bearer secret-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('preserves tokens containing spaces', async () => {
    const token = 'token with spaces';
    const app = createApp(token);
    const response = await app.request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('accepts query-string tokens for the SSE events endpoint', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/api/v1/events?token=secret-token');
    expect(response.status).toBe(200);
  });

  it('rejects query-string tokens for non-SSE endpoints', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected?token=secret-token');
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe(
      'Query-string tokens are only supported for GET /api/v1/events',
    );
  });

  it('rejects query-string tokens for non-SSE endpoints even with authorization header', async () => {
    const app = createApp('secret-token');
    const response = await app.request('/protected?token=secret-token', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe(
      'Query-string tokens are only supported for GET /api/v1/events',
    );
  });
});

describe('authentication with api key store', () => {
  it('accepts a valid managed API key', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);
    const { plaintext } = await apiKeyStore.create({ name: 'test-key' });

    const app = createApp(undefined, apiKeyStore);
    const response = await app.request('/protected', {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(response.status).toBe(200);
  });

  it('rejects an invalid managed API key', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);

    const app = createApp(undefined, apiKeyStore);
    const response = await app.request('/protected', {
      headers: {
        authorization:
          'Bearer ab_live_0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    expect(response.status).toBe(401);
  });

  it('sets scope and key id headers on successful api key auth', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);
    const { plaintext } = await apiKeyStore.create({
      name: 'scoped-key',
      scopes: ['runs:read', 'runs:write'],
    });

    const app = new Hono();
    app.use('*', requestIdentifier);
    app.use('*', createAuthentication(undefined, apiKeyStore));
    app.get('/check-headers', (c) => {
      return c.json({
        keyId: c.req.header('x-api-key-id'),
        scopes: c.req.header('x-api-key-scopes'),
      });
    });
    app.onError(errorHandler);

    const response = await app.request('/check-headers', {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keyId).toBeString();
    expect(body.scopes).toBe('runs:read,runs:write');
  });

  it('falls back to static token when api key verification fails', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);

    const app = createApp('static-secret', apiKeyStore);
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer static-secret' },
    });
    expect(response.status).toBe(200);
  });

  it('allows requests when no auth token and no api key store', async () => {
    const app = createApp(undefined, undefined);
    const response = await app.request('/protected');
    expect(response.status).toBe(200);
  });

  it('requires auth when api key store is present even without static token', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);

    const app = createApp(undefined, apiKeyStore);
    const response = await app.request('/protected');
    expect(response.status).toBe(401);
  });
});
