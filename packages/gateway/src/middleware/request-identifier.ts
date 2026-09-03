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
 * {@link createRequestIdentifier} bound directly to the real global.
 *
 * `createGateway` does NOT use this export (AB-303): it always calls
 * `createRequestIdentifier(runtimeServices.identifiers)` itself, so with
 * the default (unconfigured) `RuntimeServices` it gets a `request-<n>-
 * <uuid>`-shaped identifier from `createDefaultRuntimeServices()`'s
 * `identifiers.next('request')` — not the plain UUID this export produces.
 * This standalone export exists for callers that want the `x-request-id`
 * middleware directly, outside gateway construction.
 */
export const requestIdentifier = createRequestIdentifier({ next: () => crypto.randomUUID() });
