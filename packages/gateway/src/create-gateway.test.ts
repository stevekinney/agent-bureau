import { createStore } from '@lostgradient/operative/store';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import type { ToolRequestContext } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { sha256HexSync } from 'interoperability';

import { createBunAdapter, handleWsUpgrade } from './adapters/bun-adapter';
import type { ServerAdapter, ServerHandle } from './adapters/types';
import {
  buildRequestAuthorityValidator,
  buildWsAuthenticate,
  createGateway,
  DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS,
  raceDrainTimeout,
} from './create-gateway';
import type { ApiKey, ApiKeyStore } from './keys/types';
import {
  resolveTrustedRequestContext,
  staticTokenAuthorizationRevision,
} from './middleware/authentication';
import { DEFAULT_PORT } from './types';

type RequestAuthorityValidator = (context: ToolRequestContext) => boolean | Promise<boolean>;

/**
 * Shared across every describe block in this file (not just
 * `describe('createGateway', ...)`) so the AB-235 shutdown-drain tests
 * below can build a minimal bureau without duplicating this stub.
 */
function createGatewayBureauStub(
  hostValidator?: RequestAuthorityValidator,
  kv: Parameters<typeof createGateway>[0]['kv'] = undefined,
) {
  let requestAuthorityValidator = hostValidator;
  const bureau = {
    store: createStore(),
    memory: undefined,
    scheduler: undefined,
    ready: true,
    kv,
    subscribeLiveFrames: () => () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setRequestAuthorityValidator(validator: RequestAuthorityValidator | undefined) {
      requestAuthorityValidator = validator;
    },
    getRequestAuthorityValidator() {
      return requestAuthorityValidator;
    },
    getConfiguration() {
      return {
        provider: undefined,
        providers: [],
        maximumSteps: 3,
        systemPrompt: undefined,
        tools: [],
      };
    },
  } as unknown as Parameters<typeof createGateway>[0];

  return {
    bureau,
    getRequestAuthorityValidator: () => requestAuthorityValidator,
  };
}

describe('createGateway', () => {
  function staticTokenRequestContext(authToken: string, ownerId = 'bureau'): ToolRequestContext {
    return {
      authority: {
        principalId: 'static-token',
        tenantId: 'bureau',
        ownerId,
        capabilities: ['*'],
        authorizationRevision: staticTokenAuthorizationRevision(authToken),
      },
      audience: 'operator',
    };
  }

  it('creates a gateway with default options', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const gateway = await createGateway(bureau);
    expect(gateway.app).toBeDefined();
    expect(gateway.store).toBeDefined();
    expect(gateway.port).toBe(DEFAULT_PORT);
    bureau.dispose();
  });

  it('uses a custom port', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const gateway = await createGateway(bureau, { port: 9999 });
    expect(gateway.port).toBe(9999);
    bureau.dispose();
  });

  it('uses a provided store', async () => {
    const store = createStore();
    const bureau = await createBureau({
      agents: {},
      store,
    });
    const gateway = await createGateway(bureau);
    expect(gateway.store).toBe(store);
    bureau.dispose();
  });

  it('default port is 5555', () => {
    expect(DEFAULT_PORT).toBe(5555);
  });

  it('exposes a start function', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const gateway = await createGateway(bureau);
    expect(typeof gateway.start).toBe('function');
    bureau.dispose();
  });

  it('accepts serverRuntime option', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const gateway = await createGateway(bureau, { serverRuntime: 'bun' });
    expect(gateway.app).toBeDefined();
    bureau.dispose();
  });

  it('exposes the bureau as a property on the gateway', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const gateway = await createGateway(bureau);
    expect(gateway.bureau).toBe(bureau);
    bureau.dispose();
  });

  it('gateway does not dispose the bureau on stop', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    let disposed = false;
    const originalDispose = bureau.dispose.bind(bureau);
    bureau.dispose = async () => {
      disposed = true;
      await originalDispose();
    };
    const gateway = await createGateway(bureau);
    // Verify the gateway holds a reference to the passed bureau
    // and that merely holding the gateway does not dispose the bureau.
    // The caller owns the bureau lifecycle.
    expect(gateway.bureau).toBe(bureau);
    expect(disposed).toBe(false);
    await bureau.dispose();
  });

  it('preserves the host authority validator when gateway has no credential mechanism', async () => {
    const hostValidator = (context: ToolRequestContext) =>
      context.authority.tenantId === 'host-tenant';
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(hostValidator);

    expect(getRequestAuthorityValidator()).toBe(hostValidator);
    await createGateway(bureau);

    const validator = getRequestAuthorityValidator();
    const allowedContext = staticTokenRequestContext('unused');
    expect(validator).toBe(hostValidator);
    expect(
      await validator!({
        ...allowedContext,
        authority: {
          ...allowedContext.authority,
          tenantId: 'host-tenant',
        },
      }),
    ).toBe(true);
    expect(await validator!(staticTokenRequestContext('unused'))).toBe(false);
  });

  it('installs gateway authority freshness validation when gateway owns credentials', async () => {
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub();

    await createGateway(bureau, { authToken: 'secret' });

    const validator = getRequestAuthorityValidator();
    expect(validator).toBeDefined();
    expect(await validator!(staticTokenRequestContext('secret'))).toBe(true);
    expect(await validator!(staticTokenRequestContext('rotated-secret'))).toBe(false);
  });

  it('dispatches authority validation by issuer without requiring both validators', async () => {
    const hostValidator = (context: ToolRequestContext) =>
      context.authority.ownerId === 'allowed-owner';
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(hostValidator);

    await createGateway(bureau, { authToken: 'secret' });

    const validator = getRequestAuthorityValidator();
    expect(validator).toBeDefined();
    expect(validator).not.toBe(hostValidator);
    expect(await validator!(staticTokenRequestContext('secret', 'allowed-owner'))).toBe(true);
    expect(await validator!(staticTokenRequestContext('secret', 'blocked-owner'))).toBe(true);
    expect(await validator!(staticTokenRequestContext('rotated-secret', 'allowed-owner'))).toBe(
      false,
    );
    expect(
      await validator!({
        ...staticTokenRequestContext('unrelated-secret'),
        authority: {
          ...staticTokenRequestContext('unrelated-secret').authority,
          principalId: 'host-principal',
          tenantId: 'host-tenant',
          ownerId: 'allowed-owner',
          authorizationRevision: 'host:authority:1',
        },
      }),
    ).toBe(true);
    expect(
      await validator!({
        ...staticTokenRequestContext('unrelated-secret'),
        authority: {
          ...staticTokenRequestContext('unrelated-secret').authority,
          principalId: 'host-principal',
          tenantId: 'other-tenant',
          ownerId: 'blocked-owner',
          authorizationRevision: 'host:authority:1',
        },
      }),
    ).toBe(false);
  });

  it('uses the host validator for non-Gateway transport revisions regardless of principal naming', async () => {
    const hostValidator = (context: ToolRequestContext) =>
      context.authority.ownerId === 'host-owner';
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(hostValidator);

    await createGateway(bureau, { authToken: 'secret' });
    const validator = getRequestAuthorityValidator()!;
    const context = staticTokenRequestContext('not-used', 'host-owner');

    expect(
      await validator({
        ...context,
        authority: {
          ...context.authority,
          principalId: 'api-key:another-transport',
          authorizationRevision: 'static-token:transport:1',
        },
      }),
    ).toBe(true);
  });

  it('retains every active gateway validator while preserving the host validator', async () => {
    const hostValidator = (context: ToolRequestContext) =>
      context.authority.ownerId === 'allowed-owner';
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(hostValidator);

    await createGateway(bureau, { authToken: 'first-secret' });
    await createGateway(bureau, { authToken: 'second-secret' });

    const validator = getRequestAuthorityValidator()!;
    expect(await validator(staticTokenRequestContext('first-secret', 'allowed-owner'))).toBe(true);
    expect(await validator(staticTokenRequestContext('second-secret', 'allowed-owner'))).toBe(true);
    expect(await validator(staticTokenRequestContext('second-secret', 'blocked-owner'))).toBe(true);
  });

  it('preserves a host validator replaced after the previous gateway was created', async () => {
    const originalHostValidator = (context: ToolRequestContext) =>
      context.authority.ownerId === 'original-owner';
    const replacementHostValidator = (context: ToolRequestContext) =>
      context.authority.ownerId === 'replacement-owner';
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(originalHostValidator);

    await createGateway(bureau, { authToken: 'first-secret' });
    bureau.setRequestAuthorityValidator(replacementHostValidator);
    await createGateway(bureau, { authToken: 'second-secret' });

    const validator = getRequestAuthorityValidator()!;
    const hostContext = {
      ...staticTokenRequestContext('unrelated-secret'),
      authority: {
        ...staticTokenRequestContext('unrelated-secret').authority,
        principalId: 'host-principal',
        authorizationRevision: 'host:authority:2',
      },
    };
    expect(
      await validator({
        ...hostContext,
        authority: { ...hostContext.authority, ownerId: 'original-owner' },
      }),
    ).toBe(false);
    expect(
      await validator({
        ...hostContext,
        authority: { ...hostContext.authority, ownerId: 'replacement-owner' },
      }),
    ).toBe(true);
  });

  it('does not overwrite a host validator replaced while a gateway is active', async () => {
    const originalHostValidator = () => true;
    const replacementHostValidator = () => false;
    const { bureau, getRequestAuthorityValidator } = createGatewayBureauStub(originalHostValidator);
    const gateway = await createGateway(bureau, { authToken: 'secret', port: 0 });
    const runningGateway = await gateway.start();

    bureau.setRequestAuthorityValidator(replacementHostValidator);
    await runningGateway.stop();

    expect(getRequestAuthorityValidator()).toBe(replacementHostValidator);
  });

  it('preserves static-token authority revisions across gateway restarts', async () => {
    const kv = textValueStore(new MemoryStorage());
    const first = createGatewayBureauStub(undefined, kv);
    const firstGateway = await createGateway(first.bureau, { authToken: 'stable-secret' });
    firstGateway.app.get('/test-authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'bureau')),
    );
    const firstResponse = await firstGateway.app.request('/test-authority', {
      headers: { authorization: 'Bearer stable-secret' },
    });
    const firstContext = (await firstResponse.json()) as ToolRequestContext;

    const second = createGatewayBureauStub(undefined, kv);
    const secondGateway = await createGateway(second.bureau, { authToken: 'stable-secret' });
    secondGateway.app.get('/test-authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'bureau')),
    );
    const secondResponse = await secondGateway.app.request('/test-authority', {
      headers: { authorization: 'Bearer stable-secret' },
    });
    const secondContext = (await secondResponse.json()) as ToolRequestContext;

    expect(secondContext.authority.authorizationRevision).toBe(
      firstContext.authority.authorizationRevision,
    );
    expect(await second.getRequestAuthorityValidator()!(firstContext)).toBe(true);
  });

  it('converges static-token authority revisions during concurrent gateway startup', async () => {
    const kv = textValueStore(new MemoryStorage());
    const first = createGatewayBureauStub(undefined, kv);
    const second = createGatewayBureauStub(undefined, kv);
    const [firstGateway, secondGateway] = await Promise.all([
      createGateway(first.bureau, { authToken: 'stable-secret' }),
      createGateway(second.bureau, { authToken: 'stable-secret' }),
    ]);
    firstGateway.app.get('/test-authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'bureau')),
    );
    secondGateway.app.get('/test-authority', (context) =>
      context.json(resolveTrustedRequestContext(context, 'bureau')),
    );

    const [firstResponse, secondResponse] = await Promise.all([
      firstGateway.app.request('/test-authority', {
        headers: { authorization: 'Bearer stable-secret' },
      }),
      secondGateway.app.request('/test-authority', {
        headers: { authorization: 'Bearer stable-secret' },
      }),
    ]);
    const firstContext = (await firstResponse.json()) as ToolRequestContext;
    const secondContext = (await secondResponse.json()) as ToolRequestContext;

    expect(secondContext.authority.authorizationRevision).toBe(
      firstContext.authority.authorizationRevision,
    );
    expect(await first.getRequestAuthorityValidator()!(secondContext)).toBe(true);
    expect(await second.getRequestAuthorityValidator()!(firstContext)).toBe(true);
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

describe('buildRequestAuthorityValidator', () => {
  const requestContext = {
    authority: {
      principalId: 'api-key:key-1',
      tenantId: 'bureau',
      ownerId: 'bureau',
      capabilities: ['tools:execute', 'runs:write'],
      authorizationRevision: 'gateway:api-key:key-1',
    },
    audience: 'operator' as const,
  };

  function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
    return {
      id: 'key-1',
      name: 'test',
      keyHash: 'hash',
      scopes: ['runs:write'],
      createdAt: new Date().toISOString(),
      active: true,
      ...overrides,
    };
  }

  function makeStore(key: ApiKey | undefined): ApiKeyStore {
    return {
      verify: async () => null,
      create: async () => ({ key: key!, plaintext: 'unused' }),
      revoke: async () => undefined,
      list: async () => (key ? [key] : []),
      rotate: async () => ({ key: key!, plaintext: 'unused' }),
    };
  }

  it('accepts only a current managed-key authority snapshot', async () => {
    const currentValidator = buildRequestAuthorityValidator(undefined, makeStore(makeKey()));
    const inactiveValidator = buildRequestAuthorityValidator(
      undefined,
      makeStore(makeKey({ active: false })),
    );
    const expiredValidator = buildRequestAuthorityValidator(
      undefined,
      makeStore(makeKey({ expiresAt: new Date(0).toISOString() })),
    );
    const changedScopeValidator = buildRequestAuthorityValidator(
      undefined,
      makeStore(makeKey({ scopes: ['runs:read'] })),
    );

    expect(currentValidator).toBeDefined();
    expect(inactiveValidator).toBeDefined();
    expect(expiredValidator).toBeDefined();
    expect(changedScopeValidator).toBeDefined();
    expect(await currentValidator!(requestContext)).toBe(true);
    expect(await inactiveValidator!(requestContext)).toBe(false);
    expect(await expiredValidator!(requestContext)).toBe(false);
    expect(await changedScopeValidator!(requestContext)).toBe(false);
  });

  it('leaves the authority validator unset when no credential mechanism exists', () => {
    expect(buildRequestAuthorityValidator(undefined, undefined)).toBeUndefined();
  });

  it('normalizes managed scopes before comparing captured capabilities', async () => {
    const validator = buildRequestAuthorityValidator(
      undefined,
      makeStore(makeKey({ scopes: ['runs:write', 'tools:execute', 'runs:write'] })),
    );

    expect(validator).toBeDefined();
    expect(await validator!(requestContext)).toBe(true);
  });

  it('accepts only the configured unrestricted static authority', async () => {
    const validator = buildRequestAuthorityValidator('secret', undefined);
    expect(validator).toBeDefined();
    expect(
      await validator!({
        ...requestContext,
        authority: {
          ...requestContext.authority,
          principalId: 'static-token',
          capabilities: ['*'],
          authorizationRevision: staticTokenAuthorizationRevision('secret'),
        },
      }),
    ).toBe(true);
    expect(
      await validator!({
        ...requestContext,
        authority: {
          ...requestContext.authority,
          principalId: 'static-token',
          capabilities: ['*'],
          authorizationRevision: staticTokenAuthorizationRevision('wrong-secret'),
        },
      }),
    ).toBe(false);
    expect(
      await validator!({
        ...requestContext,
        authority: {
          ...requestContext.authority,
          principalId: 'static-token',
          capabilities: ['*'],
          authorizationRevision: `gateway:static-token:${sha256HexSync(
            'agent-bureau.gateway.static-token.authorization-revision:secret',
          ).slice(0, 32)}`,
        },
      }),
    ).toBe(false);
  });

  it('invalidates static-token authority snapshots after credential rotation', async () => {
    const originalRevision = staticTokenAuthorizationRevision('original-secret');
    const rotatedRevision = staticTokenAuthorizationRevision('rotated-secret');
    const originalAuthority = {
      ...requestContext,
      authority: {
        ...requestContext.authority,
        principalId: 'static-token',
        capabilities: ['*'],
        authorizationRevision: originalRevision,
      },
    };
    const originalValidator = buildRequestAuthorityValidator('original-secret', undefined);
    const rotatedValidator = buildRequestAuthorityValidator('rotated-secret', undefined);

    expect(originalRevision).not.toBe(rotatedRevision);
    expect(originalRevision).not.toContain('original-secret');
    expect(rotatedRevision).not.toContain('rotated-secret');
    expect(originalValidator).toBeDefined();
    expect(rotatedValidator).toBeDefined();
    expect(await originalValidator!(originalAuthority)).toBe(true);
    expect(await rotatedValidator!(originalAuthority)).toBe(false);
  });
});

/**
 * A controllable fake for the injected `setTimeoutFn`/`clearTimeoutFn`
 * dependencies, shared by every describe block below that needs to fire a
 * drain timeout deterministically rather than waiting in real time.
 */
function createFakeTimer() {
  let scheduled: { callback: () => void } | undefined;
  let cleared = false;
  const setTimeoutFn = (callback: () => void, _ms: number): unknown => {
    scheduled = { callback };
    return 1;
  };
  const clearTimeoutFn = (_handle: unknown): void => {
    cleared = true;
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire: () => scheduled?.callback(),
    wasCleared: () => cleared,
  };
}

describe('raceDrainTimeout', () => {
  it('resolves true when the stopping promise settles before the timeout fires', async () => {
    const timer = createFakeTimer();
    const result = await raceDrainTimeout(Promise.resolve(), 10_000, {
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    expect(result).toBe(true);
    expect(timer.wasCleared()).toBe(true);
  });

  it('resolves true when the stopping promise rejects before the timeout fires', async () => {
    const timer = createFakeTimer();
    const rejecting = Promise.reject(new Error('boom'));
    // Suppress the unhandled-rejection warning without changing what
    // raceDrainTimeout itself observes — it gets the raw rejecting promise.
    rejecting.catch(() => undefined);

    const result = await raceDrainTimeout(rejecting, 10_000, {
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    expect(result).toBe(true);
  });

  it('resolves false when the injected timeout fires before the stopping promise settles', async () => {
    const timer = createFakeTimer();
    let releaseStopping: (() => void) | undefined;
    const stopping = new Promise<void>((resolve) => {
      releaseStopping = resolve;
    });

    const resultPromise = raceDrainTimeout(stopping, 10_000, {
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    timer.fire();
    expect(await resultPromise).toBe(false);

    // Clean up the still-pending stopping promise so it doesn't linger.
    releaseStopping?.();
  });

  it('falls back to the real global timers when no dependencies are provided', async () => {
    // `createGateway` always supplies both `setTimeoutFn`/`clearTimeoutFn`
    // explicitly (AB-303, from its resolved `RuntimeServices.timers`), so
    // this real-timer default path is exercised only by a direct call like
    // this one. `stopping` is already resolved, so `Promise.race` settles
    // on that microtask long before the real 10s timer could ever fire —
    // this proves the default wiring, not a real wait.
    const result = await raceDrainTimeout(Promise.resolve(), 10_000);
    expect(result).toBe(true);
  });
});

describe('createGateway — AB-235 shutdown drain', () => {
  /**
   * A fake `ServerAdapter` whose `ServerHandle.stop()` never resolves on
   * its own — it only settles once `forceClose()` is called — so the
   * AB-235 drain-timeout race can be exercised deterministically without a
   * real server. Captures the `wsHandler` the gateway wires up so a test
   * can open a fake WebSocket through it and simulate a client that never
   * disconnects on its own — the exact "lingering connection" scenario
   * AB-235 force-closes.
   */
  function createHangingAdapter() {
    let resolveStop: (() => void) | undefined;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    let forceCloseCalls = 0;
    let capturedWsHandler: Parameters<ServerAdapter['serve']>[1]['wsHandler'];

    const handle: ServerHandle = {
      port: 0,
      stop: () => stopPromise,
      forceClose: () => {
        forceCloseCalls++;
        resolveStop?.();
      },
    };
    const adapter: ServerAdapter = {
      mountStaticFiles: () => undefined,
      serve: (_app, options) => {
        capturedWsHandler = options.wsHandler;
        return handle;
      },
    };
    return {
      adapter,
      getForceCloseCalls: () => forceCloseCalls,
      getWsHandler: () => capturedWsHandler,
    };
  }

  /** A fake `ServerAdapter` whose `stop()` resolves immediately. */
  function createCleanAdapter() {
    let forceCloseCalls = 0;
    const handle: ServerHandle = {
      port: 0,
      stop: async () => undefined,
      forceClose: () => {
        forceCloseCalls++;
      },
    };
    const adapter: ServerAdapter = {
      mountStaticFiles: () => undefined,
      serve: () => handle,
    };
    return { adapter, getForceCloseCalls: () => forceCloseCalls };
  }

  it('exposes DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS as 10000', () => {
    expect(DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS).toBe(10_000);
  });

  it('accepts an omitted shutdown option and defaults drainTimeoutMs', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter } = createCleanAdapter();
    const gateway = await createGateway(bureau, {}, { resolveAdapterFn: async () => adapter });
    expect(gateway).toBeDefined();
  });

  it('rejects a non-positive-integer drainTimeoutMs', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter } = createCleanAdapter();

    let caught: unknown;
    try {
      await createGateway(
        bureau,
        { shutdown: { drainTimeoutMs: 0 } },
        { resolveAdapterFn: async () => adapter },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('rejects a fractional drainTimeoutMs', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter } = createCleanAdapter();

    let caught: unknown;
    try {
      await createGateway(
        bureau,
        { shutdown: { drainTimeoutMs: 1.5 } },
        { resolveAdapterFn: async () => adapter },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('rejects a drainTimeoutMs that overflows the runtime timer range', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter } = createCleanAdapter();

    // Bun/Node clamp a setTimeout delay above 2_147_483_647ms to 1ms rather
    // than honoring it — accepting this would silently force-close
    // connections almost immediately instead of the much longer drain the
    // caller asked for.
    let caught: unknown;
    try {
      await createGateway(
        bureau,
        { shutdown: { drainTimeoutMs: 2_147_483_648 } },
        { resolveAdapterFn: async () => adapter },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('accepts a drainTimeoutMs exactly at the runtime timer maximum', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter } = createCleanAdapter();

    const gateway = await createGateway(
      bureau,
      { shutdown: { drainTimeoutMs: 2_147_483_647 } },
      { resolveAdapterFn: async () => adapter },
    );
    expect(gateway).toBeDefined();
  });

  it('reports drained: true and forcedConnections: 0 for a clean shutdown', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter, getForceCloseCalls } = createCleanAdapter();
    const gateway = await createGateway(
      bureau,
      { shutdown: { drainTimeoutMs: 5000 } },
      { resolveAdapterFn: async () => adapter },
    );

    const runningGateway = await gateway.start();
    const report = await runningGateway.stop();

    expect(report).toEqual({ drained: true, forcedConnections: 0 });
    expect(getForceCloseCalls()).toBe(0);
  });

  it('closes an open fake WebSocket, times out via an injected timer, and force-closes it', async () => {
    const { bureau } = createGatewayBureauStub();
    const { adapter, getForceCloseCalls, getWsHandler } = createHangingAdapter();
    const timer = createFakeTimer();
    const gateway = await createGateway(
      bureau,
      { shutdown: { drainTimeoutMs: 5000 } },
      {
        resolveAdapterFn: async () => adapter,
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      },
    );

    const runningGateway = await gateway.start();
    const wsHandler = getWsHandler();
    expect(wsHandler).toBeDefined();

    // Open one fake WebSocket through the wsHandler the gateway wired up —
    // this registers it as a live-frame subscriber — and never call
    // handler.close() on it, simulating a client that never disconnects on
    // its own (the "lingering connection" AB-235 exists to bound).
    let fakeWsClosed = false;
    // The handler only ever calls `send`/`close` on this — Bun's real
    // ServerWebSocket generic signature can't be satisfied by a partial
    // object, so this goes through `unknown` first (same pattern as
    // bun-adapter.test.ts's fake server).
    const fakeWs = {
      send: () => undefined,
      close: () => (fakeWsClosed = true),
    } as unknown as Parameters<NonNullable<typeof wsHandler>['open']>[0];
    wsHandler!.open(fakeWs);

    const stopPromise = runningGateway.stop();

    // Let the microtask queue drain so raceDrainTimeout has registered its
    // timer before we fire it — firing too early would race the promise
    // chain non-deterministically.
    await Promise.resolve();
    await Promise.resolve();

    timer.fire();
    const report = await stopPromise;

    // closeAll() (via LiveFrameBroker) asked the fake WebSocket to close as
    // part of the drain, in parallel with the adapter's own stop() — but it
    // never took the handler's close() path, so it was still open when the
    // drain timeout elapsed and force-close had to run.
    expect(fakeWsClosed).toBe(true);
    expect(report.drained).toBe(false);
    expect(report.forcedConnections).toBe(1);
    expect(getForceCloseCalls()).toBe(1);
  });
});
