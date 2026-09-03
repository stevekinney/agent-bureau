import { createMiddleware } from 'hono/factory';
import type { RuntimeServices } from 'lifecycle';

/**
 * Builds the `x-request-id` middleware over an injected
 * {@link RuntimeServices.identifiers | identifiers} seam (AB-303). If the
 * request already carries an `x-request-id` header, it is reused;
 * otherwise a new identifier is minted via `identifiers.next('request')`.
 */
export function createRequestIdentifier(identifiers: Pick<RuntimeServices['identifiers'], 'next'>) {
  return createMiddleware(async (context, next) => {
    const id = context.req.header('x-request-id') ?? identifiers.next('request');
    context.set('requestId', id);
    try {
      await next();
    } finally {
      context.header('x-request-id', id);
    }
  });
}

/**
 * Adds an `x-request-id` header to every response, minting a fresh UUID via
 * `crypto.randomUUID()` when the request carries none. This is
 * {@link createRequestIdentifier} bound to the real global — the default
 * `createGateway` itself uses when `options.runtime` is omitted (AB-303) —
 * kept as a standalone export for callers that want the middleware
 * directly, outside gateway construction.
 */
export const requestIdentifier = createRequestIdentifier({ next: () => crypto.randomUUID() });
