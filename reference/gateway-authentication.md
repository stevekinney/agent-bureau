# Gateway Authentication

## Overview

The gateway has a `createAuthentication()` middleware that supports a single static Bearer token. This is the bare minimum—it has no key management, no rate limiting, no key rotation, and no scoping. The gateway can't be exposed beyond localhost without better auth.

This work upgrades the gateway's authentication to support managed API keys stored in `KeyValueStore`, per-key rate limiting, key scoping, and key lifecycle management via API routes.

## What Exists Today

Read these files to understand the current state:

- `packages/gateway/src/middleware/authentication.ts` — `createAuthentication()` (single token)
- `packages/gateway/src/middleware/authentication.test.ts` — existing tests
- `packages/gateway/src/middleware/index.ts` — middleware barrel
- `packages/gateway/src/types.ts` — `GatewayOptions` (has `authToken`)
- `packages/gateway/src/create-gateway.ts` — gateway creation, applies middleware
- `packages/gateway/src/storage.ts` — gateway storage helpers
- `packages/storage/src/types.ts` — `KeyValueStore` interface

## Product Requirements

### PR-1: API Key Management

Replace the single static token with a managed key system:

```typescript
interface ApiKey {
  /** The key ID (prefix of the key, e.g., "ab_live_abc123"). */
  id: string;
  /** Display name for identification. */
  name: string;
  /** SHA-256 hash of the full key. The plaintext is never stored. */
  keyHash: string;
  /** Scopes this key is allowed to access. Empty = all scopes. */
  scopes: string[];
  /** ISO timestamp when the key was created. */
  createdAt: string;
  /** ISO timestamp when the key expires. Undefined = no expiry. */
  expiresAt?: string;
  /** Whether the key is currently active. */
  active: boolean;
  /** Last time this key was used successfully. */
  lastUsedAt?: string;
}

interface ApiKeyStore {
  create(options: CreateApiKeyOptions): Promise<{ key: ApiKey; plaintext: string }>;
  verify(token: string): Promise<ApiKey | null>;
  revoke(id: string): Promise<void>;
  list(): Promise<ApiKey[]>;
  rotate(id: string): Promise<{ key: ApiKey; plaintext: string }>;
}

interface CreateApiKeyOptions {
  name: string;
  scopes?: string[];
  expiresAt?: string;
}
```

Key format: `ab_live_<32 random hex chars>`. The prefix makes keys identifiable in logs without being valid.

Keys are stored in `KeyValueStore` under `api-key:<id>` prefix. The plaintext key is returned exactly once on creation—only the hash is persisted.

### PR-2: Scoped Access

Define a scope system for gateway routes:

| Scope | Routes |
|---|---|
| `runs:read` | `GET /runs`, `GET /runs/:id` |
| `runs:write` | `POST /runs`, `DELETE /runs/:id`, `POST /runs/:id/abort` |
| `conversations:read` | `GET /conversations`, `GET /conversations/:id` |
| `conversations:write` | `DELETE /conversations/:id` |
| `config:read` | `GET /configuration`, `GET /health` |
| `keys:manage` | `POST /keys`, `GET /keys`, `DELETE /keys/:id`, `POST /keys/:id/rotate` |

An empty scope list on a key means "all scopes" (admin key). The authentication middleware checks scopes after verifying the key.

### PR-3: Rate Limiting

Per-key rate limiting using a sliding window counter:

```typescript
interface RateLimitOptions {
  /** Maximum requests per window. Default: 60. */
  maxRequests: number;
  /** Window duration in ms. Default: 60_000 (1 minute). */
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}
```

Rate limit state is stored in memory (not `KeyValueStore`) because it's ephemeral and high-frequency. The middleware adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers to every response.

When rate limited, return `429 Too Many Requests` with a `Retry-After` header.

### PR-4: Key Management API Routes

New routes under `/keys`:

- `POST /keys` — create a new API key. Body: `{ name, scopes?, expiresAt? }`. Returns `{ key: ApiKey, plaintext: string }`. Requires `keys:manage` scope.
- `GET /keys` — list all keys (without hashes). Requires `keys:manage` scope.
- `DELETE /keys/:id` — revoke a key. Requires `keys:manage` scope.
- `POST /keys/:id/rotate` — revoke the old key and create a new one with the same name/scopes. Returns the new plaintext. Requires `keys:manage` scope.

### PR-5: Backward Compatibility

The existing `authToken` option in `GatewayOptions` must continue to work. When `authToken` is set and no `KeyValueStore` is configured, use the old single-token behavior. When a `KeyValueStore` is available, the system uses managed keys. Both can coexist—the static token acts as an admin key.

### PR-6: Bootstrap Key

On first startup when no keys exist, the gateway should generate a bootstrap admin key and print it to stdout exactly once. This key has all scopes and no expiry. The message format:

```
[gateway] Bootstrap API key created: ab_live_<hex>
[gateway] Store this key securely — it will not be shown again.
```

## Architecture

### New Files

In `packages/gateway/src/middleware/`:

- `rate-limiter.ts` — `createRateLimiter()` factory, sliding window implementation
- `rate-limiter.test.ts` — tests
- `scope-guard.ts` — `createScopeGuard()` middleware factory
- `scope-guard.test.ts` — tests

In `packages/gateway/src/keys/`:

- `types.ts` — `ApiKey`, `ApiKeyStore`, `CreateApiKeyOptions`, `RateLimitOptions`
- `create-api-key-store.ts` — `createApiKeyStore()` factory
- `create-api-key-store.test.ts` — tests
- `key-utilities.ts` — key generation, hashing, verification helpers
- `key-utilities.test.ts` — tests
- `bootstrap.ts` — bootstrap key creation on first startup
- `bootstrap.test.ts` — tests
- `index.ts` — re-exports

In `packages/gateway/src/routes/`:

- `keys.ts` — key management routes
- `keys.test.ts` — tests

### Extended Files

- `packages/gateway/src/middleware/authentication.ts` — upgrade to use `ApiKeyStore`
- `packages/gateway/src/middleware/authentication.test.ts` — extended tests
- `packages/gateway/src/types.ts` — add `ApiKeyStore`, rate limit config to `GatewayOptions`
- `packages/gateway/src/create-gateway.ts` — wire key store, rate limiter, scope guard
- `packages/gateway/src/routes/index.ts` — add key routes

### Security Considerations

- Keys are hashed with SHA-256 before storage. Plaintext is never persisted.
- Key verification uses constant-time comparison to prevent timing attacks.
- Rate limit counters are in-memory only—they reset on restart (acceptable for single-process).
- Bootstrap key generation uses `crypto.randomBytes(32)` for key material.
- Expired keys are rejected during verification, not just on listing.

## Implementation Order (TDD)

### Phase 1: Key Utilities

1. Write tests for key generation and hashing:
   - `generateApiKey()` returns key in `ab_live_<hex>` format
   - `hashApiKey()` returns consistent SHA-256 hex
   - `verifyApiKey()` compares against hash (constant-time)
   - `extractKeyId()` extracts the first 8 hex chars as ID
   - Generated keys are unique (generate 100, all different)
2. Implement `key-utilities.ts`
3. Verify: `bun test packages/gateway/src/keys/key-utilities.test.ts`

### Phase 2: API Key Store

1. Write tests for `createApiKeyStore()`:
   - `create()` returns key with plaintext
   - `create()` stores only the hash, not plaintext
   - `verify()` returns key for valid token
   - `verify()` returns null for invalid token
   - `verify()` returns null for expired key
   - `verify()` returns null for revoked key
   - `verify()` updates `lastUsedAt`
   - `revoke()` marks key as inactive
   - `list()` returns all keys without hashes
   - `rotate()` revokes old key and creates new one with same config
   - Works with `createMemoryKeyValueStore()`
2. Implement `create-api-key-store.ts`
3. Verify: `bun test packages/gateway/src/keys/create-api-key-store.test.ts`

### Phase 3: Rate Limiter

1. Write tests for `createRateLimiter()`:
   - Allows requests under limit
   - Blocks requests over limit
   - Window resets after duration
   - Returns correct `remaining` count
   - Returns correct `resetAt` timestamp
   - Independent limits per key ID
   - Cleanup of expired windows doesn't leak memory
2. Implement `rate-limiter.ts`
3. Verify: `bun test packages/gateway/src/middleware/rate-limiter.test.ts`

### Phase 4: Scope Guard

1. Write tests for `createScopeGuard()`:
   - Key with matching scope passes
   - Key with missing scope returns 403
   - Key with empty scopes (admin) passes all checks
   - Multiple required scopes all checked
2. Implement `scope-guard.ts`
3. Verify: `bun test packages/gateway/src/middleware/scope-guard.test.ts`

### Phase 5: Authentication Upgrade

1. Write tests:
   - Static `authToken` still works (backward compatible)
   - Managed API key verified via `ApiKeyStore`
   - Rate limit headers present on response
   - Rate limited request returns 429
   - Expired key returns 401
   - Revoked key returns 401
   - Scope mismatch returns 403
   - No auth configured (no token, no store) → all requests pass
2. Update `authentication.ts`
3. Verify: `bun test packages/gateway/src/middleware/authentication.test.ts`

### Phase 6: Key Management Routes

1. Write tests:
   - `POST /keys` creates key and returns plaintext
   - `GET /keys` lists keys without sensitive data
   - `DELETE /keys/:id` revokes key
   - `POST /keys/:id/rotate` creates replacement key
   - All routes require `keys:manage` scope
   - Invalid key ID returns 404
2. Implement `routes/keys.ts`
3. Verify: `bun test packages/gateway/src/routes/keys.test.ts`

### Phase 7: Bootstrap Key

1. Write tests:
   - First startup with empty store creates bootstrap key
   - Second startup with existing keys does not create another
   - Bootstrap key has all scopes and no expiry
2. Implement `bootstrap.ts`
3. Wire into `create-gateway.ts`
4. Verify: `bun test packages/gateway/src/keys/bootstrap.test.ts`

### Phase 8: Integration

1. Run full gateway suite: `bun test packages/gateway/`
2. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `createApiKeyStore()` exported from gateway
- [ ] API keys generated in `ab_live_<hex>` format
- [ ] Key plaintext returned once on creation, only hash stored
- [ ] `ApiKeyStore.verify()` authenticates valid keys and rejects invalid/expired/revoked
- [ ] Key verification uses constant-time comparison
- [ ] Per-key rate limiting with sliding window
- [ ] Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) on every response
- [ ] 429 response with `Retry-After` when rate limited
- [ ] Scope-based access control on all routes
- [ ] Empty scopes = admin access to all routes
- [ ] Key management routes (`POST /keys`, `GET /keys`, `DELETE /keys/:id`, `POST /keys/:id/rotate`)
- [ ] All key management routes require `keys:manage` scope
- [ ] Static `authToken` option still works (backward compatible)
- [ ] Bootstrap admin key created on first startup when no keys exist
- [ ] Expired keys rejected during verification
- [ ] `rotate()` revokes old key and creates replacement
- [ ] 100% test coverage: `bun test --coverage packages/gateway/src/keys/` and `bun test --coverage packages/gateway/src/middleware/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies (uses only `crypto` from Node builtins and existing Hono)
- [ ] All new modules follow factory-function pattern
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/gateway/src/keys/          # Key store tests
bun test packages/gateway/src/middleware/     # Middleware tests
bun test packages/gateway/src/routes/        # Route tests
bun test --coverage packages/gateway/        # Coverage
turbo run check-types --filter=gateway       # Type check
turbo run lint --filter=gateway              # Lint
turbo run validate                           # Full pipeline
```

<promise>GATEWAY_AUTH_COMPLETE</promise>
<promise>GATEWAY_AUTH_FAILED</promise>
