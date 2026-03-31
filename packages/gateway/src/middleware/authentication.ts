import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import type { ApiKeyStore } from '../keys/types';

const QUERY_TOKEN_PATH_ALLOW_LIST = new Set(['/api/v1/events']);

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
export function createAuthentication(authToken: string | undefined, apiKeyStore?: ApiKeyStore) {
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

    if (!authHeader && hasDisallowedQueryToken) {
      throw new HTTPException(401, {
        message: 'Query-string tokens are only supported for GET /api/v1/events',
      });
    }

    if (!authHeader && !queryToken) {
      throw new HTTPException(401, { message: 'Missing authorization header' });
    }

    const token = authHeader
      ? authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined
      : (queryToken ?? undefined);

    if (!token) {
      throw new HTTPException(401, { message: 'Missing authorization token' });
    }

    if (!queryToken && authHeader && !authHeader.toLowerCase().startsWith('bearer ')) {
      throw new HTTPException(401, { message: 'Invalid authorization token' });
    }

    // Try managed API key verification first
    if (apiKeyStore && token.startsWith('ab_live_')) {
      const key = await apiKeyStore.verify(token);
      if (key) {
        // Inject key metadata as headers for downstream middleware
        headers.set('x-api-key-id', key.id);
        headers.set('x-auth-principal', `api-key:${key.id}`);
        headers.set('x-api-key-scopes', key.scopes.join(','));
        commitHeaders();
        await next();
        return;
      }
    }

    // Fall back to static token comparison
    if (authToken && token === authToken) {
      headers.set('x-auth-principal', 'static-token');
      commitHeaders();
      await next();
      return;
    }

    throw new HTTPException(401, { message: 'Invalid authorization token' });
  });
}
