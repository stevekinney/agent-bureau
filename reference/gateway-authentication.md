# Gateway Authentication

> [!NOTE]
> **Status**: Managed gateway authentication is shipped. This note now describes the current implementation rather than a pending design.

## Overview

**Gateway authentication**: The gateway now supports managed API keys, route scopes, bootstrap key creation, and principal-aware rate limiting. The old single static bearer token is still supported, but only as the simple fallback path and as an admin-style token for environments that do not want managed keys yet.

This matters because the live transport changed the shape of the problem. Once you support long-lived browser sessions over WebSocket and EventSource, authentication is no longer just about protecting `POST /runs`. It has to protect live feeds, key management, and the routes that expose session history.

## Current Architecture

The implementation is centered on these files:

- `packages/gateway/src/middleware/authentication.ts`: verifies managed keys, static token fallback, and EventSource query-token access
- `packages/gateway/src/middleware/rate-limiter.ts`: principal-aware sliding-window limiter with optional `KeyValueStore` backing
- `packages/gateway/src/middleware/scope-guard.ts`: route-level scope enforcement
- `packages/gateway/src/keys/*`: key generation, hashing, persistence, bootstrap, and routes
- `packages/gateway/src/routes/index.ts`: scope wiring for runs, sessions, configuration, events, and key management
- `packages/gateway/src/types.ts`: exported scope constants and gateway auth types

## Request Flow

The current request flow works like this:

- A managed `ab_live_...` token is verified through `ApiKeyStore`
- On success, the middleware injects `x-api-key-id`, `x-api-key-scopes`, and `x-auth-principal`
- Downstream middleware uses that injected principal for rate limiting and scope checks
- If managed-key verification does not match, the static `authToken` still works as a fallback

For live browser streams, the same middleware also accepts `?token=` query authentication. That is there for server-sent events, where the browser `EventSource` API does not let you attach arbitrary headers.

## Scope Model

The gateway now uses explicit route scopes:

- `runs:read`
- `runs:write`
- `sessions:read`
- `sessions:write`
- `config:read`
- `keys:manage`

The important branch-level change here is that session routes are scoped as _sessions_, not conversations. The authorization model matches the product surface that now shipped.

## Rate Limiting

The original authentication reference assumed an in-memory-only limiter. That is no longer accurate.

The current limiter is:

- keyed by authenticated principal, not only raw key identifier
- able to use shared `KeyValueStore` backing when configured
- still able to fall back to in-memory state when no store is present
- applied to static-token traffic as well through the `static-token` principal

That means the gateway can now preserve limiter state across middleware instances and treat the static token like a real authenticated principal instead of an unmetered escape hatch.

## Key Management Surface

The gateway now includes:

- bootstrap admin key creation
- key creation and listing
- revocation
- rotation
- scope-aware enforcement for the management routes themselves

The static token still has value for simple local setups, but the managed-key path is the intended product surface.

## Boundaries and Future Work

This auth model is solid for the current gateway product surface, but it is not the final word:

- There is no external identity-provider integration yet.
- Audit trails and richer operator-facing access history would still add value.
- Multi-tenant policy administration and delegated key ownership are still future product work.

Those are expansion problems now, not missing baseline functionality.

## Verification

Use these commands when touching gateway authentication or access control:

```bash
bun test packages/gateway/
bun run validate
```
