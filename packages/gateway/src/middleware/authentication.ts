import type { ToolRequestContext } from 'armorer';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { hmacSha256HexSync } from 'interoperability';

import { normalizeApiKeyScopes } from '../keys/create-api-key-store';
import type { ApiKeyStore } from '../keys/types';

const QUERY_TOKEN_PATH_ALLOW_LIST = new Set(['/api/v1/events']);
const DEFAULT_BUREAU_AGENT_NAME = 'bureau';
const TOOL_EXECUTION_CAPABILITY = 'tools:execute';
const UNRESTRICTED_CAPABILITY = '*';
const AUTHORIZATION_REVISION_HEADER = 'x-auth-authorization-revision';
const PROCESS_STATIC_TOKEN_REVISION_SECRET = crypto.randomUUID();

function gatewayAuthorityOwnerId(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BUREAU_AGENT_NAME;
}

function parseGatewayScopes(scopesHeader: string | undefined): string[] {
  if (scopesHeader === undefined || scopesHeader === '') return [];
  return normalizeGatewayScopes(scopesHeader.split(','));
}

export function normalizeGatewayScopes(scopes: readonly string[]): string[] {
  return normalizeApiKeyScopes(scopes);
}

export function gatewayCapabilitiesForScopes(scopes: readonly string[]): string[] {
  const normalizedScopes = normalizeGatewayScopes(scopes);
  return normalizedScopes.length === 0
    ? [UNRESTRICTED_CAPABILITY]
    : Array.from(new Set([TOOL_EXECUTION_CAPABILITY, ...normalizedScopes]));
}

export function gatewayAuthorizationRevisionForApiKey(apiKeyId: string): string {
  return `gateway:api-key:${apiKeyId}`;
}

export function staticTokenAuthorizationRevision(
  authToken: string,
  revisionSecret: string = PROCESS_STATIC_TOKEN_REVISION_SECRET,
): string {
  return `gateway:static-token:${hmacSha256HexSync(revisionSecret, authToken).slice(0, 32)}`;
}

/**
 * Resolves the authenticated principal for the current request from the
 * `x-auth-principal` header this middleware injects after verification
 * (`api-key:<id>` or `static-token`). Falls back to `'anonymous'` when no
 * auth is configured at all (the middleware injects no header in that case).
 *
 * The single source of truth for "who made this request" — used both to
 * attribute review decisions (AB-20) and to attribute created runs for usage
 * analytics (AB-54).
 */
export function resolvePrincipal(context: Context): string {
  return context.req.header('x-auth-principal') ?? 'anonymous';
}

/**
 * Builds the trusted Armorer request context from authentication metadata
 * injected by `createAuthentication`. Caller-supplied request bodies and
 * client-injected auth headers are intentionally ignored.
 */
export function resolveTrustedRequestContext(
  context: Context,
  agentName: string | undefined,
): ToolRequestContext | undefined {
  const principal = context.req.header('x-auth-principal');
  if (!principal) return undefined;

  const authorizationRevision = context.req.header(AUTHORIZATION_REVISION_HEADER);
  if (!authorizationRevision) return undefined;

  const scopesHeader = context.req.header('x-api-key-scopes');
  const scopes = scopesHeader === undefined ? [] : parseGatewayScopes(scopesHeader);
  const capabilities = gatewayCapabilitiesForScopes(scopes);
  const ownerId = gatewayAuthorityOwnerId(agentName);

  return {
    authority: {
      principalId: principal,
      tenantId: 'bureau',
      ownerId,
      capabilities,
      authorizationRevision,
    },
    audience: 'operator',
  };
}

/**
 * Bearer token authentication middleware with managed API key support.
 *
 * When an `ApiKeyStore` is provided, tokens matching the `ab_live_` prefix are
 * verified against the store first. If verification succeeds, the key's id,
 * principal, and scopes are injected as request headers (`x-api-key-id`,
 * `x-auth-principal`, `x-api-key-scopes`) for downstream middleware
 * (rate limiter, scope guard) to consume.
 *
 * The static `authToken` is still accepted as a fallback and acts as an admin
 * key with no scope restrictions.
 *
 * When neither `authToken` nor `apiKeyStore` is configured, all requests pass.
 */
export function createAuthentication(
  authToken: string | undefined,
  apiKeyStore?: ApiKeyStore,
  staticTokenRevisionSecret: string = PROCESS_STATIC_TOKEN_REVISION_SECRET,
) {
  return createMiddleware(async (context, next) => {
    // Strip any client-injected scope/key headers to prevent spoofing.
    // These headers are set exclusively by this middleware after verification.
    // We always build a single replacement Request to avoid consuming the body
    // stream more than once.
    const raw = context.req.raw;
    const headers = new Headers(raw.headers);
    headers.delete('x-api-key-id');
    headers.delete('x-api-key-scopes');
    headers.delete('x-auth-principal');
    headers.delete(AUTHORIZATION_REVISION_HEADER);

    /** Replaces context.req.raw with a new Request carrying the current headers. */
    function commitHeaders(): void {
      const request = new Request(raw.url, {
        method: raw.method,
        headers,
        body: raw.body,
        // @ts-expect-error — duplex is needed for streaming bodies in some runtimes
        duplex: raw.body ? 'half' : undefined,
      });
      Object.defineProperty(context.req, 'raw', { value: request, writable: true });
    }

    // When no auth is configured at all, pass through
    if (!authToken && !apiKeyStore) {
      commitHeaders();
      await next();
      return;
    }

    const authHeader = context.req.header('authorization');
    const url = new URL(raw.url);
    const allowsQueryToken =
      raw.method.toUpperCase() === 'GET' && QUERY_TOKEN_PATH_ALLOW_LIST.has(url.pathname);
    const queryToken = allowsQueryToken ? url.searchParams.get('token') : null;
    const hasDisallowedQueryToken = !allowsQueryToken && url.searchParams.has('token');

    if (hasDisallowedQueryToken) {
      throw new HTTPException(401, {
        message: 'Query-string tokens are only supported for GET /api/v1/events',
      });
    }

    if (!authHeader && !queryToken) {
      throw new HTTPException(401, { message: 'Missing authorization header' });
    }

    if (authHeader && !authHeader.toLowerCase().startsWith('bearer ')) {
      throw new HTTPException(401, { message: 'Invalid authorization token' });
    }

    const token = authHeader ? authHeader.slice(7).trim() : (queryToken ?? undefined);

    if (!token) {
      throw new HTTPException(401, { message: 'Missing authorization token' });
    }

    // Try managed API key verification first
    if (apiKeyStore && token.startsWith('ab_live_')) {
      const key = await apiKeyStore.verify(token);
      if (key) {
        // Inject key metadata as headers for downstream middleware
        let normalizedScopes: string[];
        try {
          normalizedScopes = normalizeGatewayScopes(key.scopes);
        } catch {
          throw new HTTPException(401, { message: 'Invalid authorization token' });
        }
        headers.set('x-api-key-id', key.id);
        headers.set('x-auth-principal', `api-key:${key.id}`);
        headers.set('x-api-key-scopes', normalizedScopes.join(','));
        headers.set(AUTHORIZATION_REVISION_HEADER, gatewayAuthorizationRevisionForApiKey(key.id));
        commitHeaders();
        await next();
        return;
      }
    }

    // Fall back to static token comparison
    if (authToken && token === authToken) {
      headers.set('x-auth-principal', 'static-token');
      headers.set(
        AUTHORIZATION_REVISION_HEADER,
        staticTokenAuthorizationRevision(authToken, staticTokenRevisionSecret),
      );
      commitHeaders();
      await next();
      return;
    }

    throw new HTTPException(401, { message: 'Invalid authorization token' });
  });
}
