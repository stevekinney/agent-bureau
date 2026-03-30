# Model Fallover

## Overview

Herald classifies SDK errors into `HeraldError` with `retryable` flag and `statusCode`. Operative has `RetryOptions` that can use `shouldRetryHeraldError`. But there's no fallback _chain_—when a provider is down, rate-limited, or returns an auth error, the agent dies. Production agents need to cascade through alternative providers or models.

This work adds a fallover system to the herald package that wraps multiple `GenerateFunction` instances into a single one with cascading failure recovery.

## What Exists Today

Read these files to understand the current state:

- `packages/herald/src/errors.ts` — `HeraldError`, `shouldRetryHeraldError()`
- `packages/herald/src/types.ts` — `ProviderName`, `BaseProviderOptions`, provider option types
- `packages/herald/src/anthropic.ts` — `createAnthropicGenerate()`
- `packages/herald/src/openai.ts` — `createOpenAIGenerate()`
- `packages/herald/src/gemini.ts` — `createGeminiGenerate()`
- `packages/operative/src/types.ts` — `GenerateFunction`, `GenerateResponse`, `RetryOptions`

## Product Requirements

### PR-1: Fallover Chain

`createFalloverGenerate()` accepts an ordered list of `GenerateFunction` instances and returns a single `GenerateFunction`. When the primary fails:

1. Classify the error via `HeraldError` properties
2. Decide whether to try the next provider based on error type
3. Cascade to the next function in the chain
4. If all functions fail, throw a `FalloverExhaustedError` that wraps all individual errors

Error classification rules:

| Error Type | Action |
|---|---|
| Auth error (401, 403) | Skip to next provider immediately |
| Rate limit (429) | Skip to next provider immediately |
| Server error (500, 502, 503, 504) | Retry with backoff on same provider up to `retriesPerProvider`, then skip |
| Overflow / context too long (400 with specific message patterns) | Do NOT fall over — this is a content problem, not a provider problem. Rethrow immediately. |
| Network error (no status code) | Retry once on same provider, then skip |
| Unknown error | Skip to next provider |

### PR-2: Provider Health Tracking

Track provider health across calls to avoid repeatedly hitting dead providers:

- **Cooldown period**: When a provider fails with a non-transient error (auth, billing), put it on cooldown for a configurable duration (default: 5 minutes). Skip cooldown providers during cascade.
- **Success resets**: A successful call resets the provider's health state.
- **Health query**: Expose `getProviderHealth()` for monitoring/debugging.

```typescript
interface ProviderHealth {
  name: string;
  available: boolean;
  lastError?: { code: number; message: string; timestamp: number };
  cooldownUntil?: number;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
}
```

### PR-3: Configurable Fallover Behavior

```typescript
interface FalloverOptions {
  /** Ordered list of generate functions. First is primary. */
  providers: FalloverProvider[];
  /** Max retries per provider for server errors before cascading. Default: 1. */
  retriesPerProvider?: number;
  /** Base delay between retries in ms. Doubles per attempt. Default: 1000. */
  retryDelay?: number;
  /** Cooldown duration in ms for providers with auth/billing errors. Default: 300_000. */
  cooldownDuration?: number;
  /** Called when a provider fails and the chain cascades. */
  onFallover?: (event: FalloverEvent) => void;
  /** Called when a provider recovers after being on cooldown. */
  onRecovery?: (provider: string) => void;
  /** Custom error classifier. Overrides default classification. */
  classifyError?: (error: unknown) => ErrorClassification;
}

interface FalloverProvider {
  name: string;
  generate: GenerateFunction;
}

interface FalloverEvent {
  failedProvider: string;
  nextProvider: string;
  error: unknown;
  errorType: ErrorClassification;
  attempt: number;
}

type ErrorClassification =
  | 'auth'
  | 'rate-limit'
  | 'server-error'
  | 'overflow'
  | 'network'
  | 'unknown';
```

### PR-4: Error Classification Utility

Extract error classification into a standalone utility that works with any error shape, not just `HeraldError`:

```typescript
function classifyProviderError(error: unknown): ErrorClassification;
```

This function checks:
1. If it's a `HeraldError`, use `statusCode` and `retryable`
2. If it has a `status` or `statusCode` property, use that
3. If the error message matches overflow patterns (`"context_length_exceeded"`, `"max_tokens"`, etc.), classify as `'overflow'`
4. If there's no status code and it looks like a network error (`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`), classify as `'network'`
5. Otherwise `'unknown'`

### PR-5: FalloverExhaustedError

When all providers fail, throw a structured error:

```typescript
class FalloverExhaustedError extends Error {
  readonly errors: ReadonlyArray<{ provider: string; error: unknown }>;
  readonly lastError: unknown;
}
```

## Architecture

### New Files

All in `packages/herald/src/fallover/`:

- `types.ts` — `FalloverOptions`, `FalloverProvider`, `FalloverEvent`, `ErrorClassification`, `ProviderHealth`
- `classify-error.ts` — `classifyProviderError()`
- `provider-health.ts` — `createProviderHealthTracker()`
- `create-fallover-generate.ts` — `createFalloverGenerate()` factory
- `errors.ts` — `FalloverExhaustedError`
- `index.ts` — re-exports

### Extended Files

- `packages/herald/src/index.ts` — re-export fallover modules
- `packages/herald/package.json` — add `"./fallover"` subpath export

### No New Dependencies

This adds zero new dependencies. It uses only `HeraldError` from the existing herald errors module and standard TypeScript.

## Implementation Order (TDD)

### Phase 1: Error Classification

1. Write tests for `classifyProviderError()`:
   - `HeraldError` with status 401 → `'auth'`
   - `HeraldError` with status 429 → `'rate-limit'`
   - `HeraldError` with status 500/502/503/504 → `'server-error'`
   - Error with message containing `"context_length_exceeded"` → `'overflow'`
   - Error with message containing `"ECONNREFUSED"` → `'network'`
   - Plain `Error` with no status → `'unknown'`
   - Non-Error values → `'unknown'`
   - Custom error objects with `status` property → classified by status code
2. Implement `classify-error.ts`
3. Verify: `bun test packages/herald/src/fallover/classify-error.test.ts`

### Phase 2: Provider Health Tracker

1. Write tests for `createProviderHealthTracker()`:
   - New tracker shows all providers available
   - `recordFailure()` with auth error puts provider on cooldown
   - Provider on cooldown reports `available: false`
   - `recordSuccess()` resets cooldown and consecutive failures
   - Cooldown expires after configured duration
   - `getHealth()` returns accurate stats
   - `getAvailableProviders()` filters out cooldown providers
   - Multiple concurrent failures tracked independently
2. Implement `provider-health.ts`
3. Verify: `bun test packages/herald/src/fallover/provider-health.test.ts`

### Phase 3: FalloverExhaustedError

1. Write tests:
   - Contains all provider errors
   - `lastError` is the final provider's error
   - Message summarizes which providers failed
   - `instanceof Error` is true
2. Implement in `errors.ts`
3. Verify: `bun test packages/herald/src/fallover/errors.test.ts`

### Phase 4: Fallover Generate

1. Write tests for `createFalloverGenerate()`:
   - Primary succeeds → returns primary's response
   - Primary auth error → cascades to secondary, secondary succeeds
   - Primary rate limit → cascades immediately (no retry)
   - Primary server error → retries on primary, then cascades
   - Primary overflow → throws immediately, does NOT cascade
   - All providers fail → throws `FalloverExhaustedError`
   - Cooldown provider skipped on subsequent calls
   - `onFallover` callback fired with correct event
   - Provider recovery after cooldown expires
   - `onRecovery` callback fired when provider recovers
   - Custom `classifyError` overrides default classification
   - AbortSignal respected during retries
   - Respects `retriesPerProvider` count
   - Retry delay doubles per attempt (exponential backoff)
2. Implement `create-fallover-generate.ts`
3. Verify: `bun test packages/herald/src/fallover/create-fallover-generate.test.ts`

### Phase 5: Integration

1. Add re-exports to `packages/herald/src/index.ts`
2. Add `"./fallover"` subpath to `packages/herald/package.json`
3. Build and verify: `turbo run build --filter=herald`
4. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `createFalloverGenerate()` exported from `herald` and `herald/fallover`
- [ ] `classifyProviderError()` exported from `herald` and `herald/fallover`
- [ ] `FalloverExhaustedError` exported from `herald` and `herald/fallover`
- [ ] Primary success returns response directly with no overhead
- [ ] Auth errors (401, 403) cascade immediately without retry
- [ ] Rate limit errors (429) cascade immediately without retry
- [ ] Server errors retry up to `retriesPerProvider` with exponential backoff, then cascade
- [ ] Overflow errors throw immediately without cascading
- [ ] Network errors retry once, then cascade
- [ ] All providers failing throws `FalloverExhaustedError` with all errors attached
- [ ] Provider cooldown prevents repeated calls to failing providers
- [ ] Cooldown expires after configured duration
- [ ] Successful call resets provider health
- [ ] `onFallover` callback fires on every cascade with correct event
- [ ] `onRecovery` callback fires when cooldown provider succeeds again
- [ ] Custom `classifyError` overrides default classification
- [ ] AbortSignal is forwarded and respected during retries
- [ ] 100% test coverage: `bun test --coverage packages/herald/src/fallover/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All new modules follow factory-function pattern
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/herald/src/fallover/       # Unit tests
bun test --coverage packages/herald/         # Coverage
turbo run check-types --filter=herald        # Type check
turbo run lint --filter=herald               # Lint
turbo run validate                           # Full pipeline
```

<promise>MODEL_FALLOVER_COMPLETE</promise>
<promise>MODEL_FALLOVER_FAILED</promise>
