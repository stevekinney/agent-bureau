import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sha256HexSync } from 'interoperability';

import { createApiKeyStore } from '../keys/create-api-key-store';
import type { ApiKeyStore } from '../keys/types';
import {
  createAuthentication,
  gatewayAuthorizationRevisionForApiKey,
  gatewayCapabilitiesForScopes,
  resolveTrustedRequestContext,
  staticTokenAuthorizationRevision,
} from './authentication';
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

  it('rejects a "Bearer " header whose token is empty after trimming', async () => {
    const app = createApp('secret-token');
    // A trailing plain space is stripped by the Fetch `Headers` normalization
    // itself (HTTP whitespace, RFC 9110), collapsing this header value back to
    // "Bearer" before it ever reaches the middleware — which fails the
    // `startsWith('bearer ')` check instead of reaching this branch. A
    // trailing non-breaking space (U+00A0) is NOT header-whitespace, so it
    // survives that normalization, but IS whitespace per `String.prototype.trim()`
    // — landing exactly on the "header present, well-formed, token empty
    // after trim" case this branch guards.
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer  ' },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Missing authorization token');
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
  it('represents managed and static admin credentials as unrestricted authority', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);
    const { plaintext } = await apiKeyStore.create({ name: 'admin-key', scopes: [] });

    const app = new Hono();
    app.use('*', createAuthentication('static-secret', apiKeyStore));
    app.get('/authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'billing-agent')),
    );

    for (const token of [plaintext, 'static-secret']) {
      const response = await app.request('/authority', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.authority.capabilities).toEqual(['*']);
    }
  });

  it('derives static-token authorization revision without preserving the token value', async () => {
    const token = 'rotatable-static-secret';
    const app = new Hono();
    app.use('*', createAuthentication(token));
    app.get('/authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'billing-agent')),
    );

    const response = await app.request('/authority', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.authority.authorizationRevision).toBe(staticTokenAuthorizationRevision(token));
    expect(body.authority.authorizationRevision).not.toBe('gateway:static-token');
    expect(body.authority.authorizationRevision).not.toContain(token);
    expect(body.authority.authorizationRevision).not.toBe(
      `gateway:static-token:${sha256HexSync(
        `agent-bureau.gateway.static-token.authorization-revision:${token}`,
      ).slice(0, 32)}`,
    );
  });

  it('normalizes managed scopes before exposing trusted request authority', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);
    const { key, plaintext } = await apiKeyStore.create({
      name: 'duplicate-scope-key',
      scopes: ['runs:write', 'tools:execute', 'runs:write'],
    });

    const app = new Hono();
    app.use('*', createAuthentication(undefined, apiKeyStore));
    app.get('/authority', (context) =>
      context.json({
        scopes: context.req.header('x-api-key-scopes'),
        requestContext: resolveTrustedRequestContext(context, 'billing-agent'),
      }),
    );

    const response = await app.request('/authority', {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.scopes).toBe('runs:write,tools:execute');
    expect(body.requestContext.authority.capabilities).toEqual(
      gatewayCapabilitiesForScopes(key.scopes),
    );
    expect(body.requestContext.authority.authorizationRevision).toBe(
      gatewayAuthorizationRevisionForApiKey(key.id),
    );
  });

  it('rejects malformed stored scopes instead of promoting them to unrestricted authority', async () => {
    const kv = textValueStore(new MemoryStorage());
    const apiKeyStore = createApiKeyStore(kv);
    const { key, plaintext } = await apiKeyStore.create({
      name: 'tampered-scope-key',
      scopes: ['runs:write'],
    });
    const raw = await kv.get(`api-key:${key.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!);
    stored.scopes = ['   '];
    await kv.set(`api-key:${key.id}`, JSON.stringify(stored));

    const app = createApp(undefined, apiKeyStore);
    const response = await app.request('/protected', {
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Invalid authorization token');
    expect(() => gatewayCapabilitiesForScopes(['   '])).toThrow(
      'API key scope entries must be non-blank strings',
    );
  });

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

  // AB-212 regression: `commitHeaders()` rebuilds `context.req.raw` on every
  // request (even the no-auth pass-through) to strip client-spoofable
  // headers. Before this fix, the replacement `Request` carried no `signal`,
  // so a downstream route's `context.req.raw.signal` was a fresh,
  // never-aborting signal — completely disconnected from the caller's real
  // one. This silently broke every request-disconnect propagation path
  // (AB-212's attached-run abort included) regardless of which route or
  // auth branch handled the request.
  describe('forwards the original request signal through the header rewrite (AB-212)', () => {
    function createSignalCapturingApp(authToken: string | undefined, apiKeyStore?: ApiKeyStore) {
      const app = new Hono();
      app.use('*', requestIdentifier);
      app.use('*', createAuthentication(authToken, apiKeyStore));
      let capturedSignal: AbortSignal | undefined;
      app.get('/capture', (c) => {
        capturedSignal = c.req.raw.signal;
        return c.json({ ok: true });
      });
      app.onError(errorHandler);
      return { app, getCapturedSignal: () => capturedSignal };
    }

    it('propagates a later abort on the no-auth pass-through branch', async () => {
      const { app, getCapturedSignal } = createSignalCapturingApp(undefined, undefined);
      const controller = new AbortController();

      const response = await app.request('/capture', { signal: controller.signal });
      expect(response.status).toBe(200);

      const capturedSignal = getCapturedSignal();
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      let fired = false;
      capturedSignal!.addEventListener('abort', () => {
        fired = true;
      });
      controller.abort();

      expect(fired).toBe(true);
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('propagates a later abort on the authenticated branch', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      const { plaintext } = await apiKeyStore.create({
        name: 'signal-test',
        scopes: ['runs:read'],
      });
      const { app, getCapturedSignal } = createSignalCapturingApp(undefined, apiKeyStore);
      const controller = new AbortController();

      const response = await app.request('/capture', {
        headers: { authorization: `Bearer ${plaintext}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);

      const capturedSignal = getCapturedSignal();
      expect(capturedSignal).toBeDefined();

      let fired = false;
      capturedSignal!.addEventListener('abort', () => {
        fired = true;
      });
      controller.abort();

      expect(fired).toBe(true);
    });
  });
});
