import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * Creates a scope guard middleware that checks whether the authenticated API
 * key has the required scopes. Scope information is read from the
 * `x-api-key-scopes` header, set by the authentication middleware.
 *
 * Behavior:
 * - Empty scopes on the key (header value is `""`) means admin access: all checks pass.
 * - Missing header entirely (unauthenticated or static token) passes through.
 * - If `requiredScopes` is empty, all requests pass.
 * - Otherwise, every required scope must be present in the key's scopes.
 */
export function createScopeGuard(requiredScopes: string[]) {
  return createMiddleware(async (context, next) => {
    if (requiredScopes.length === 0) {
      await next();
      return;
    }

    const scopesHeader = context.req.header('x-api-key-scopes');

    // No scopes header means static token or unauthenticated — let the auth
    // middleware handle access control, not the scope guard.
    if (scopesHeader === undefined) {
      await next();
      return;
    }

    // Empty scopes means admin key — passes all checks
    if (scopesHeader === '') {
      await next();
      return;
    }

    const keyScopes = scopesHeader.split(',').map((s) => s.trim());
    const missing = requiredScopes.filter((scope) => !keyScopes.includes(scope));

    if (missing.length > 0) {
      throw new HTTPException(403, {
        message: `Insufficient scope. Missing: ${missing.join(', ')}`,
      });
    }

    await next();
  });
}
