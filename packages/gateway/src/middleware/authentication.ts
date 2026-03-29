import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import type { ApiKeyStore } from '../keys/types';

/**
 * Bearer token authentication middleware with managed API key support.
 *
 * When an `ApiKeyStore` is provided, tokens matching the `ab_live_` prefix are
 * verified against the store first. If verification succeeds, the key's id and
 * scopes are injected as request headers (`x-api-key-id`, `x-api-key-scopes`)
 * for downstream middleware (rate limiter, scope guard) to consume.
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
    const raw = context.req.raw;
    if (raw.headers.has('x-api-key-id') || raw.headers.has('x-api-key-scopes')) {
      const sanitized = new Headers(raw.headers);
      sanitized.delete('x-api-key-id');
      sanitized.delete('x-api-key-scopes');
      const sanitizedRequest = new Request(raw.url, {
        method: raw.method,
        headers: sanitized,
        body: raw.body,
        // @ts-expect-error — duplex is needed for streaming bodies in some runtimes
        duplex: raw.body ? 'half' : undefined,
      });
      Object.defineProperty(context.req, 'raw', { value: sanitizedRequest, writable: true });
    }

    // When no auth is configured at all, pass through
    if (!authToken && !apiKeyStore) {
      await next();
      return;
    }

    const header = context.req.header('authorization');
    if (!header) {
      throw new HTTPException(401, { message: 'Missing authorization header' });
    }

    if (!header.toLowerCase().startsWith('bearer ')) {
      throw new HTTPException(401, { message: 'Invalid authorization token' });
    }

    const token = header.slice(7).trim();

    // Try managed API key verification first
    if (apiKeyStore && token.startsWith('ab_live_')) {
      const key = await apiKeyStore.verify(token);
      if (key) {
        // Inject key metadata as headers for downstream middleware
        const raw = context.req.raw;
        const newHeaders = new Headers(raw.headers);
        newHeaders.set('x-api-key-id', key.id);
        newHeaders.set('x-api-key-scopes', key.scopes.join(','));

        // Replace the request with one carrying the new headers
        const newRequest = new Request(raw.url, {
          method: raw.method,
          headers: newHeaders,
          body: raw.body,
          // @ts-expect-error — duplex is needed for streaming bodies in some runtimes
          duplex: raw.body ? 'half' : undefined,
        });
        Object.defineProperty(context.req, 'raw', { value: newRequest, writable: true });

        await next();
        return;
      }
    }

    // Fall back to static token comparison
    if (authToken && token === authToken) {
      await next();
      return;
    }

    throw new HTTPException(401, { message: 'Invalid authorization token' });
  });
}
