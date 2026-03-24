import { createMiddleware } from 'hono/factory';

/**
 * Adds an `x-request-id` header to every response. If the request already
 * carries one, it is reused; otherwise a new UUID is generated.
 */
export const requestIdentifier = createMiddleware(async (context, next) => {
  const id = context.req.header('x-request-id') ?? crypto.randomUUID();
  context.set('requestId', id);
  await next();
  context.header('x-request-id', id);
});
