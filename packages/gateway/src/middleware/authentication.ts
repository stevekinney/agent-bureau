import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * Optional Bearer token authentication middleware. When `authToken` is
 * provided, requests must include a matching `Authorization: Bearer <token>`
 * header. When unconfigured (no token), all requests pass through.
 */
export function createAuthentication(authToken: string | undefined) {
  return createMiddleware(async (context, next) => {
    if (!authToken) {
      await next();
      return;
    }

    const header = context.req.header('authorization');
    if (!header) {
      throw new HTTPException(401, { message: 'Missing authorization header' });
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || token !== authToken) {
      throw new HTTPException(401, { message: 'Invalid authorization token' });
    }

    await next();
  });
}
