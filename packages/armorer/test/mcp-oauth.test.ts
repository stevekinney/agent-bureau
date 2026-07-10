import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  completeMcpOAuthAuthorization,
  connectMcpClientWithOAuth,
  createInMemoryMcpOAuthTokenStorage,
  createMCP,
  createMcpOAuthProvider,
  fromMcpClientTools,
  isMcpUnauthorizedError,
  McpAuthorizationIssuerValidationError,
  parseMcpAuthorizationCallback,
} from '../src/integrations/mcp';

/**
 * A mock authorization server + protected resource server built with
 * Bun.serve, entirely in-process. No live network endpoints are used.
 *
 * Implements just enough of the spec for the client-side flow under test:
 * - RFC 9728 protected resource metadata
 * - RFC 8414 authorization server metadata (with `authorization_response_iss_parameter_supported`)
 * - RFC 7591 dynamic client registration
 * - Authorization endpoint with PKCE (S256) verification
 * - Token endpoint for `authorization_code` and `refresh_token` grants
 * - RFC 9207 `iss` on the authorization redirect
 * - The actual MCP resource (Streamable HTTP), gated on a bearer token
 */
function createMockOAuthMcpServer() {
  const registeredClients = new Map<string, { client_id: string; redirect_uris: string[] }>();
  const issuedCodes = new Map<
    string,
    { clientId: string; codeChallenge: string; redirectUri: string; resource?: string }
  >();
  const accessTokens = new Map<string, { clientId: string }>();
  const refreshTokens = new Map<string, { clientId: string }>();
  let tokenRequestCount = 0;
  let refreshRequestCount = 0;

  const echoTool = createTool({
    name: 'echo',
    description: 'echoes the given message',
    input: z.object({ message: z.string() }),
    async execute({ message }) {
      return { message };
    },
  });

  async function sha256Base64Url(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Buffer.from(digest).toString('base64url');
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const issuer = `http://${server.hostname}:${server.port}/`;
      const url = new URL(request.url);

      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: issuer,
          authorization_servers: [issuer],
        });
      }

      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          registration_endpoint: `${issuer}register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
      }

      if (url.pathname === '/register' && request.method === 'POST') {
        const body = (await request.json()) as { redirect_uris: string[] };
        const clientId = `client-${crypto.randomUUID()}`;
        registeredClients.set(clientId, { client_id: clientId, redirect_uris: body.redirect_uris });
        return Response.json({
          ...body,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
      }

      if (url.pathname === '/authorize' && request.method === 'GET') {
        const clientId = url.searchParams.get('client_id');
        const redirectUri = url.searchParams.get('redirect_uri');
        const codeChallenge = url.searchParams.get('code_challenge');
        const codeChallengeMethod = url.searchParams.get('code_challenge_method');
        const state = url.searchParams.get('state');
        const resource = url.searchParams.get('resource');

        const client = clientId ? registeredClients.get(clientId) : undefined;
        if (!client || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
          return new Response('invalid_request', { status: 400 });
        }

        const code = `code-${crypto.randomUUID()}`;
        issuedCodes.set(code, {
          clientId: client.client_id,
          codeChallenge,
          redirectUri,
          ...(resource ? { resource } : {}),
        });

        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        if (state) redirect.searchParams.set('state', state);
        redirect.searchParams.set('iss', issuer);
        return Response.redirect(redirect.toString(), 302);
      }

      if (url.pathname === '/token' && request.method === 'POST') {
        tokenRequestCount += 1;
        const params = new URLSearchParams(await request.text());
        const grantType = params.get('grant_type');

        if (grantType === 'authorization_code') {
          const code = params.get('code');
          const codeVerifier = params.get('code_verifier');
          const clientId = params.get('client_id');
          const entry = code ? issuedCodes.get(code) : undefined;
          if (!entry || entry.clientId !== clientId || !codeVerifier) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          const computedChallenge = await sha256Base64Url(codeVerifier);
          if (computedChallenge !== entry.codeChallenge) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          issuedCodes.delete(code as string);
          const accessToken = `access-${crypto.randomUUID()}`;
          const refreshToken = `refresh-${crypto.randomUUID()}`;
          accessTokens.set(accessToken, { clientId: entry.clientId });
          refreshTokens.set(refreshToken, { clientId: entry.clientId });
          return Response.json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
          });
        }

        if (grantType === 'refresh_token') {
          refreshRequestCount += 1;
          const refreshToken = params.get('refresh_token');
          const entry = refreshToken ? refreshTokens.get(refreshToken) : undefined;
          if (!entry) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          const accessToken = `access-${crypto.randomUUID()}`;
          accessTokens.set(accessToken, { clientId: entry.clientId });
          return Response.json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }

        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }

      if (url.pathname === '/') {
        const authorizationHeader = request.headers.get('authorization');
        const token = authorizationHeader?.startsWith('Bearer ')
          ? authorizationHeader.slice('Bearer '.length)
          : undefined;
        if (!token || !accessTokens.has(token)) {
          return new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${issuer}.well-known/oauth-protected-resource"`,
            },
          });
        }

        const toolbox = createToolbox([echoTool]);
        const mcpServer = await createMCP(toolbox, {
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        });
        const transport = new WebStandardStreamableHTTPServerTransport();
        await mcpServer.connect(transport);
        return transport.handleRequest(request);
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    get issuer() {
      return `http://${server.hostname}:${server.port}/`;
    },
    get tokenRequestCount() {
      return tokenRequestCount;
    },
    get refreshRequestCount() {
      return refreshRequestCount;
    },
    stop: () => server.stop(true),
  };
}

describe('MCP OAuth client support', () => {
  let mockServer: ReturnType<typeof createMockOAuthMcpServer>;

  beforeEach(() => {
    mockServer = createMockOAuthMcpServer();
  });

  afterEach(() => {
    mockServer.stop();
  });

  it('completes the PKCE authorization-code flow, lists tools, and calls one', async () => {
    const tokenStorage = createInMemoryMcpOAuthTokenStorage();
    let capturedAuthorizationUrl: URL | undefined;

    const provider = createMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9999/callback',
      clientMetadata: {
        client_name: 'armorer-test-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      tokenStorage,
      onAuthorizationRequired(authorizationUrl) {
        capturedAuthorizationUrl = authorizationUrl;
      },
    });

    let unauthorizedThrown = false;
    try {
      await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    } catch (error) {
      unauthorizedThrown = true;
      expect(isMcpUnauthorizedError(error)).toBe(true);
    }
    expect(unauthorizedThrown).toBe(true);
    expect(capturedAuthorizationUrl).toBeDefined();

    // PKCE: the authorization request must carry an S256 code_challenge.
    expect(capturedAuthorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(capturedAuthorizationUrl?.searchParams.get('code_challenge')).toBeTruthy();

    // Simulate the user-agent visiting the authorization URL; the mock AS
    // "authenticates" instantly and 302s back to the redirect URI.
    const authorizeResponse = await fetch(capturedAuthorizationUrl as URL, { redirect: 'manual' });
    expect(authorizeResponse.status).toBe(302);
    const callbackUrl = authorizeResponse.headers.get('location');
    expect(callbackUrl).toBeTruthy();

    const result = await completeMcpOAuthAuthorization(provider, {
      serverUrl: mockServer.issuer,
      callbackUrl: callbackUrl as string,
      tokenStorage,
    });
    expect(result).toBe('AUTHORIZED');
    expect(mockServer.tokenRequestCount).toBe(1);

    const { tokens } = await tokenStorage.load();
    expect(tokens?.access_token).toBeTruthy();
    expect(tokens?.refresh_token).toBeTruthy();

    const client = await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    try {
      const tools = await fromMcpClientTools(client);
      expect(tools.map((tool) => tool.name)).toEqual(['echo']);

      const echoTool = tools[0];
      if (!echoTool) throw new Error('expected echo tool');
      const result = await echoTool.executeWith({ params: { message: 'hello' } });
      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.result).toEqual({ message: 'hello' });
      }
    } finally {
      await client.close();
    }
  });

  it('refreshes the access token instead of re-running the authorization flow', async () => {
    const tokenStorage = createInMemoryMcpOAuthTokenStorage();
    let capturedAuthorizationUrl: URL | undefined;

    const provider = createMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9999/callback',
      clientMetadata: {
        client_name: 'armorer-test-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      tokenStorage,
      onAuthorizationRequired(authorizationUrl) {
        capturedAuthorizationUrl = authorizationUrl;
      },
    });

    try {
      await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    } catch {
      // expected: UnauthorizedError, we complete the flow below
    }
    const authorizeResponse = await fetch(capturedAuthorizationUrl as URL, { redirect: 'manual' });
    const callbackUrl = authorizeResponse.headers.get('location') as string;
    await completeMcpOAuthAuthorization(provider, {
      serverUrl: mockServer.issuer,
      callbackUrl,
      tokenStorage,
    });

    // Force the stored access token to look invalid to the resource server
    // without touching the refresh token, so the next connect attempt has to
    // refresh rather than fall back to a fresh authorization redirect.
    const stored = await tokenStorage.load();
    if (!stored.tokens) throw new Error('expected tokens to be saved after authorization');
    await tokenStorage.save({ tokens: { ...stored.tokens, access_token: 'expired-token' } });

    expect(mockServer.refreshRequestCount).toBe(0);
    const client = await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    try {
      expect(mockServer.refreshRequestCount).toBe(1);
      const refreshedState = await tokenStorage.load();
      expect(refreshedState.tokens?.access_token).not.toBe('expired-token');
    } finally {
      await client.close();
    }
  });

  it('rejects an authorization response whose `iss` does not match the recorded issuer (RFC 9207)', async () => {
    const tokenStorage = createInMemoryMcpOAuthTokenStorage();
    let capturedAuthorizationUrl: URL | undefined;

    const provider = createMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9999/callback',
      clientMetadata: {
        client_name: 'armorer-test-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      tokenStorage,
      onAuthorizationRequired(authorizationUrl) {
        capturedAuthorizationUrl = authorizationUrl;
      },
    });

    try {
      await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    } catch {
      // expected
    }
    const authorizeResponse = await fetch(capturedAuthorizationUrl as URL, { redirect: 'manual' });
    const callbackUrl = new URL(authorizeResponse.headers.get('location') as string);
    callbackUrl.searchParams.set('iss', 'https://attacker.example.com/');

    let caught: unknown;
    try {
      await completeMcpOAuthAuthorization(provider, {
        serverUrl: mockServer.issuer,
        callbackUrl,
        tokenStorage,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpAuthorizationIssuerValidationError);
    // The mismatched `iss` must be rejected before the code is ever
    // exchanged at the token endpoint.
    expect(mockServer.tokenRequestCount).toBe(0);
  });

  it('rejects an authorization response missing `iss` when the server advertises support for it', async () => {
    const tokenStorage = createInMemoryMcpOAuthTokenStorage();
    let capturedAuthorizationUrl: URL | undefined;

    const provider = createMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9999/callback',
      clientMetadata: {
        client_name: 'armorer-test-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      tokenStorage,
      onAuthorizationRequired(authorizationUrl) {
        capturedAuthorizationUrl = authorizationUrl;
      },
    });

    try {
      await connectMcpClientWithOAuth({ serverUrl: mockServer.issuer, provider });
    } catch {
      // expected
    }
    const authorizeResponse = await fetch(capturedAuthorizationUrl as URL, { redirect: 'manual' });
    const callbackUrl = new URL(authorizeResponse.headers.get('location') as string);
    callbackUrl.searchParams.delete('iss');

    let caught: unknown;
    try {
      await completeMcpOAuthAuthorization(provider, {
        serverUrl: mockServer.issuer,
        callbackUrl,
        tokenStorage,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpAuthorizationIssuerValidationError);
    expect(mockServer.tokenRequestCount).toBe(0);
  });
});

describe('parseMcpAuthorizationCallback', () => {
  it('parses a full callback URL', () => {
    const result = parseMcpAuthorizationCallback(
      'https://app.example.com/callback?code=abc&state=xyz&iss=https%3A%2F%2Fas.example.com%2F',
    );
    expect(result).toEqual({ code: 'abc', state: 'xyz', iss: 'https://as.example.com/' });
  });

  it('parses a bare query string, as documented for callers that only have req.query', () => {
    const withLeadingQuestionMark = parseMcpAuthorizationCallback('?code=abc&state=xyz');
    expect(withLeadingQuestionMark).toEqual({ code: 'abc', state: 'xyz' });

    const withoutLeadingQuestionMark = parseMcpAuthorizationCallback('code=abc&state=xyz');
    expect(withoutLeadingQuestionMark).toEqual({ code: 'abc', state: 'xyz' });
  });
});

describe('createMcpOAuthProvider state()', () => {
  it('does not regenerate the state parameter mid-flow, even for a falsy stored value', async () => {
    let stored: { state?: string } = { state: '' };
    const provider = createMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:9999/callback',
      clientMetadata: { redirect_uris: ['http://127.0.0.1:9999/callback'] },
      tokenStorage: {
        load: () => stored,
        save: (patch) => {
          stored = { ...stored, ...patch };
        },
      },
      onAuthorizationRequired: () => {},
    });

    expect(await provider.state?.()).toBe('');
    expect(await provider.state?.()).toBe('');
  });
});
