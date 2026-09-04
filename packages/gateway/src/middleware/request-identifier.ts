import { createMiddleware } from 'hono/factory';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

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
 * Adds an `x-request-id` header to every response, minting a fresh
 * identifier via the real-globals {@link RuntimeServices} (AB-252, AB-327)
 * when the request carries none. This is {@link createRequestIdentifier}
 * bound directly to `createDefaultRuntimeServices().identifiers` — the one
 * sanctioned real-globals implementation of the `RuntimeServices` contract
 * — rather than a bespoke `crypto.randomUUID()` binding, so it mints the
 * same `request-<n>-<uuid>`-shaped identifier `createGateway` itself would
 * produce with an unconfigured runtime.
 *
 * `createGateway` does NOT use this export (AB-303): it always calls
 * `createRequestIdentifier(runtimeServices.identifiers)` itself over its
 * own resolved runtime. This standalone export exists for callers that
 * want the `x-request-id` middleware directly, outside gateway
 * construction.
 */
export const requestIdentifier = createRequestIdentifier(
  createDefaultRuntimeServices().identifiers,
);
