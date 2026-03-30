# LLM Response Caching

## Overview

Agent-bureau has an embedding cache in the memory package (LRU, content-hash keyed). What's missing is caching of `GenerateFunction` outputs—the actual LLM API responses. This is the single easiest cost optimization: identical or near-identical prompts return cached responses without an API call. During development and testing this cuts costs dramatically; in production it speeds up deterministic tool-use patterns.

This work adds a `withCache()` generate middleware to the operative package that wraps any `GenerateFunction` with configurable caching backed by `KeyValueStore`.

## What Exists Today

Read these files to understand the current state:

- `packages/memory/src/embedding-cache.ts` — `CachedEmbedder`, LRU cache for embeddings (pattern reference)
- `packages/operative/src/types.ts` — `GenerateFunction`, `GenerateContext`, `GenerateResponse`, `GenerateMiddleware`
- `packages/storage/src/types.ts` — `KeyValueStore` interface
- `packages/operative/src/streaming.ts` — `withStreaming()` (existing middleware pattern)

## Product Requirements

### PR-1: Cache Middleware

`withCache()` wraps a `GenerateFunction` and returns a new `GenerateFunction`:

```typescript
interface CacheOptions {
  /** Storage backend for cached responses. */
  store: KeyValueStore;
  /** TTL in seconds. 0 = no expiry. Default: 3600. */
  ttl?: number;
  /** Strategy for generating cache keys. Default: 'conversation-hash'. */
  keyStrategy?: 'conversation-hash' | 'last-message' | CacheKeyFunction;
  /** Namespace prefix for cache keys. Default: 'llm-cache:'. */
  namespace?: string;
  /** When true, tool calls in the response invalidate the cache entry. Default: false. */
  invalidateOnToolCalls?: boolean;
  /** Called on cache hit. */
  onHit?: (event: CacheHitEvent) => void;
  /** Called on cache miss. */
  onMiss?: (event: CacheMissEvent) => void;
  /** Maximum number of entries. When exceeded, oldest entries are evicted. Default: 1000. */
  maxEntries?: number;
}

type CacheKeyFunction = (context: GenerateContext) => string;

interface CacheHitEvent {
  key: string;
  age: number; // ms since cached
}

interface CacheMissEvent {
  key: string;
  duration: number; // ms the generate call took
}

function withCache(
  generate: GenerateFunction,
  options: CacheOptions,
): GenerateFunction;
```

### PR-2: Cache Key Strategies

**`conversation-hash`** (default): SHA-256 hash of the full conversation content + tool names. This gives exact-match caching: the same conversation state always returns the same response.

**`last-message`**: Hash of only the last user message + system prompt. Less precise but higher cache hit rate for repeated queries with different history prefixes.

**Custom**: Any function from `GenerateContext` to `string`.

```typescript
function conversationHashKey(context: GenerateContext): string;
function lastMessageKey(context: GenerateContext): string;
```

### PR-3: Cache Entry Structure

Cached entries stored as JSON in `KeyValueStore`:

```typescript
interface CacheEntry {
  response: GenerateResponse;
  createdAt: number; // timestamp ms
  ttl: number; // seconds
  hits: number;
  keyStrategy: string;
}
```

Expired entries are lazily cleaned up on read (check TTL before returning). The `maxEntries` eviction uses a separate cleanup pass.

### PR-4: Cache Invalidation

- **TTL-based**: Entries expire after `ttl` seconds.
- **Tool call invalidation**: When `invalidateOnToolCalls: true`, responses containing tool calls are not cached (because the tool results would be different on replay).
- **Manual invalidation**: `clearCache(store, namespace)` utility to wipe all entries.
- **Selective invalidation**: `invalidateCache(store, namespace, pattern)` to remove entries matching a key prefix.

```typescript
function clearCache(store: KeyValueStore, namespace?: string): Promise<number>;
function invalidateCache(store: KeyValueStore, namespace: string, pattern: string): Promise<number>;
```

### PR-5: Cache Metrics

Track hit/miss rates for monitoring:

```typescript
interface CacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly totalSavedTokens: number;
  readonly estimatedSavedCost: number;
  reset(): void;
}

function withCacheMetrics(
  generate: GenerateFunction,
  options: CacheOptions & { model?: string },
): { generate: GenerateFunction; metrics: CacheMetrics };
```

## Architecture

### New Files

In `packages/operative/src/cache/`:

- `types.ts` — `CacheOptions`, `CacheEntry`, `CacheHitEvent`, `CacheMissEvent`, `CacheMetrics`
- `cache-keys.ts` — `conversationHashKey()`, `lastMessageKey()`
- `with-cache.ts` — `withCache()` middleware
- `cache-metrics.ts` — `withCacheMetrics()` wrapper
- `cache-utilities.ts` — `clearCache()`, `invalidateCache()`
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/index.ts` — re-export cache modules

### No New Dependencies

Uses `KeyValueStore` from storage (already a dependency) and `Bun.CryptoHasher` for SHA-256.

## Implementation Order (TDD)

### Phase 1: Cache Key Strategies

1. Write tests:
   - `conversationHashKey()` returns consistent hash for same conversation
   - `conversationHashKey()` returns different hash for different conversations
   - `conversationHashKey()` includes tool names in hash
   - `lastMessageKey()` returns same hash regardless of history length (same last message)
   - `lastMessageKey()` includes system prompt in hash
   - Custom key function receives full `GenerateContext`
   - Keys are valid `KeyValueStore` key strings (no special chars)
2. Implement `cache-keys.ts`
3. Verify: `bun test packages/operative/src/cache/cache-keys.test.ts`

### Phase 2: Core Cache Middleware

1. Write tests for `withCache()`:
   - Cache miss: calls underlying generate, caches response, returns it
   - Cache hit: returns cached response without calling generate
   - TTL expiry: expired entry treated as miss
   - `invalidateOnToolCalls: true`: responses with tool calls not cached
   - `invalidateOnToolCalls: false`: responses with tool calls cached
   - `onHit` callback fires with key and age
   - `onMiss` callback fires with key and duration
   - Namespace prefixes all keys
   - Different conversations get different cache entries
   - Cached response is structurally identical to fresh response
   - Works with `createMemoryKeyValueStore()`
   - AbortSignal respected (don't cache aborted requests)
2. Implement `with-cache.ts`
3. Verify: `bun test packages/operative/src/cache/with-cache.test.ts`

### Phase 3: Cache Utilities

1. Write tests:
   - `clearCache()` removes all entries under namespace
   - `clearCache()` returns count of deleted entries
   - `invalidateCache()` removes entries matching pattern
   - `invalidateCache()` preserves non-matching entries
2. Implement `cache-utilities.ts`
3. Verify: `bun test packages/operative/src/cache/cache-utilities.test.ts`

### Phase 4: Cache Metrics

1. Write tests:
   - Tracks hit and miss counts
   - `hitRate` computed correctly
   - `totalSavedTokens` accumulated from cached responses
   - `estimatedSavedCost` uses `estimateCost()` when model provided
   - `reset()` zeros all counters
2. Implement `cache-metrics.ts`
3. Verify: `bun test packages/operative/src/cache/cache-metrics.test.ts`

### Phase 5: Integration

1. Wire exports into `packages/operative/src/index.ts`
2. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `withCache()` exported from `operative`
- [ ] Cache hit returns response without calling underlying generate
- [ ] Cache miss calls generate, caches, and returns response
- [ ] `conversation-hash` strategy produces consistent keys for same conversation
- [ ] `last-message` strategy ignores history prefix differences
- [ ] Custom key strategy function supported
- [ ] TTL-based expiry works correctly
- [ ] `invalidateOnToolCalls` prevents caching tool-call responses
- [ ] `onHit` and `onMiss` callbacks fire with correct data
- [ ] `clearCache()` removes all entries, returns count
- [ ] `invalidateCache()` removes matching entries only
- [ ] `CacheMetrics` tracks hits, misses, saved tokens, saved cost
- [ ] Aborted requests are not cached
- [ ] Cached responses are structurally identical to fresh responses
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/cache/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/cache/       # Cache tests
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>RESPONSE_CACHING_COMPLETE</promise>
<promise>RESPONSE_CACHING_FAILED</promise>
