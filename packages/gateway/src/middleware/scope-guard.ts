import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import { isPrivilegedGatewayConnection } from './authentication';

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

    // No scopes header (static token or unauthenticated) or an empty scopes
    // list (admin key) both mean this principal is privileged — see
    // `isPrivilegedGatewayConnection`'s own doc comment for why the two
    // are the same case.
    if (isPrivilegedGatewayConnection(scopesHeader)) {
      await next();
      return;
    }

    // `isPrivilegedGatewayConnection` already ruled out `undefined` and `''`
    // above; the fallback here is unreachable, not a behavior change.
    const keyScopes = (scopesHeader ?? '').split(',').map((s) => s.trim());
    const missing = requiredScopes.filter((scope) => !keyScopes.includes(scope));

    if (missing.length > 0) {
      throw new HTTPException(403, {
        message: `Insufficient scope. Missing: ${missing.join(', ')}`,
      });
    }

    await next();
  });
}
