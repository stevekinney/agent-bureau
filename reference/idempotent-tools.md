# Idempotent Tool Design

## Overview

No tool in armorer has idempotency support. If a tool writes to a database and the process crashes after the write but before recording the result, the tool will execute again on recovery and create a duplicate. Idempotent tools are safe to retry—they produce the same outcome whether executed once or five times. This is a prerequisite for durable execution.

This work adds idempotency key support to armorer's `createTool()` and a result cache that prevents duplicate executions.

## What Exists Today

Read these files to understand the current state:

- `packages/armorer/src/types.ts` — `ToolExecutionResult`, `MinimalToolConfiguration`
- `packages/armorer/src/index.ts` — `createTool`, `createToolbox` exports
- `packages/armorer/src/create-tool.ts` — tool creation (read this to understand the tool interface)
- `packages/armorer/src/create-toolbox.ts` — toolbox creation
- `packages/storage/src/types.ts` — `KeyValueStore` interface

## Product Requirements

### PR-1: Idempotency Key Generation

Add an optional `idempotencyKey` function to tool definitions:

```typescript
interface ToolDefinition {
  // ... existing fields
  /**
   * Generates an idempotency key from the tool call input.
   * When provided, the tool result is cached by this key.
   * Subsequent calls with the same key return the cached result.
   * Default: undefined (no idempotency).
   */
  idempotencyKey?: (input: unknown) => string;
}
```

For tools that are always safe to retry (pure functions, read-only queries), `idempotencyKey` can hash the full input:

```typescript
function hashIdempotencyKey(input: unknown): string;
```

For tools with side effects, the key should be derived from the semantically meaningful parts of the input (e.g., the order ID, not the full payload).

### PR-2: Tool Result Cache

A `createToolResultCache()` factory that stores and retrieves tool execution results:

```typescript
interface ToolResultCache {
  get(key: string): Promise<CachedToolResult | undefined>;
  set(key: string, result: CachedToolResult, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface CachedToolResult {
  result: unknown;
  toolName: string;
  executedAt: number;
  ttl: number;
}

function createToolResultCache(options: {
  store: KeyValueStore;
  /** Default TTL in seconds. 0 = no expiry. Default: 3600. */
  defaultTTL?: number;
  /** Key namespace. Default: 'tool-result:'. */
  namespace?: string;
}): ToolResultCache;
```

### PR-3: Idempotent Tool Wrapper

A `withIdempotency()` wrapper that adds caching to any tool's execute function:

```typescript
interface IdempotencyOptions {
  cache: ToolResultCache;
  /** Override TTL for this tool. */
  ttl?: number;
  /** Called when a cached result is returned instead of executing. */
  onCacheHit?: (key: string, result: CachedToolResult) => void;
}

function withIdempotency<T extends ToolDefinition>(
  tool: T,
  options: IdempotencyOptions,
): T;
```

The wrapper intercepts `execute()`:
1. Compute idempotency key from input
2. Check cache for existing result
3. If cached and not expired → return cached result
4. If not cached → execute tool, cache result, return it

### PR-4: Toolbox-Level Idempotency

Apply idempotency to all tools in a toolbox at once:

```typescript
function withToolboxIdempotency(
  toolbox: Toolbox,
  options: {
    cache: ToolResultCache;
    /** Default TTL for all tools. Individual tool TTLs override. */
    defaultTTL?: number;
    /** Only apply to tools with idempotencyKey defined. Default: true. */
    requireExplicitKey?: boolean;
  },
): Toolbox;
```

When `requireExplicitKey: false`, a hash of the full input is used as the idempotency key for tools that don't define one. This is a convenience for read-only tools but dangerous for side-effecting tools—hence the default of `true`.

### PR-5: Idempotency for Built-in Key Patterns

Provide helper functions for common idempotency key patterns:

```typescript
/** Hash the full input. Safe for pure/read-only tools. */
function fullInputKey(input: unknown): string;

/** Extract a specific field as the key. Useful for tools with an ID field. */
function fieldKey(fieldName: string): (input: unknown) => string;

/** Combine multiple fields into a composite key. */
function compositeKey(...fieldNames: string[]): (input: unknown) => string;

/** Prefix a key generator with the tool name for namespace isolation. */
function namespacedKey(
  toolName: string,
  keyFn: (input: unknown) => string,
): (input: unknown) => string;
```

## Architecture

### New Files

In `packages/armorer/src/idempotency/`:

- `types.ts` — `ToolResultCache`, `CachedToolResult`, `IdempotencyOptions`
- `create-tool-result-cache.ts` — `createToolResultCache()` factory
- `with-idempotency.ts` — `withIdempotency()` tool wrapper
- `with-toolbox-idempotency.ts` — `withToolboxIdempotency()` toolbox wrapper
- `key-generators.ts` — `fullInputKey()`, `fieldKey()`, `compositeKey()`, `namespacedKey()`
- `index.ts` — re-exports

### Extended Files

- `packages/armorer/src/types.ts` — add `idempotencyKey` to tool definition types
- `packages/armorer/src/index.ts` — re-export idempotency modules
- `packages/armorer/package.json` — add `"./idempotency"` subpath export, add storage as optional peer dep

## Implementation Order (TDD)

### Phase 1: Key Generators

1. Write tests:
   - `fullInputKey({ a: 1 })` returns consistent hash
   - `fullInputKey({ a: 1 })` and `fullInputKey({ a: 2 })` return different hashes
   - `fieldKey('id')({ id: '123', name: 'test' })` returns hash of `'123'`
   - `compositeKey('userId', 'action')({ userId: 'u1', action: 'delete' })` returns consistent hash
   - `namespacedKey('search', fullInputKey)` prefixes with tool name
   - Handles undefined/null fields gracefully
   - JSON serialization order doesn't affect hash
2. Implement `key-generators.ts`
3. Verify: `bun test packages/armorer/src/idempotency/key-generators.test.ts`

### Phase 2: Tool Result Cache

1. Write tests:
   - `set()` then `get()` returns cached result
   - `get()` for nonexistent key returns undefined
   - Expired entries return undefined
   - `delete()` removes entry
   - `clear()` removes all entries
   - TTL respected per entry
   - Namespace prefixes all keys
   - Works with `createMemoryKeyValueStore()`
2. Implement `create-tool-result-cache.ts`
3. Verify: `bun test packages/armorer/src/idempotency/create-tool-result-cache.test.ts`

### Phase 3: Tool Wrapper

1. Write tests for `withIdempotency()`:
   - First call executes tool and caches result
   - Second call with same input returns cached result without executing
   - Different input executes tool again
   - `onCacheHit` callback fires on cached return
   - Expired cache entry triggers re-execution
   - Tool without `idempotencyKey` throws descriptive error
   - Tool errors are NOT cached (only successful results)
   - Wrapper preserves all other tool properties
2. Implement `with-idempotency.ts`
3. Verify: `bun test packages/armorer/src/idempotency/with-idempotency.test.ts`

### Phase 4: Toolbox Wrapper

1. Write tests for `withToolboxIdempotency()`:
   - All tools with `idempotencyKey` wrapped
   - Tools without `idempotencyKey` left unchanged when `requireExplicitKey: true`
   - Tools without `idempotencyKey` get `fullInputKey` when `requireExplicitKey: false`
   - `defaultTTL` applied to all wrapped tools
   - Wrapped toolbox behaves identically for non-cached calls
2. Implement `with-toolbox-idempotency.ts`
3. Verify: `bun test packages/armorer/src/idempotency/with-toolbox-idempotency.test.ts`

### Phase 5: Integration

1. Wire exports
2. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `idempotencyKey` optional field on tool definitions
- [ ] `createToolResultCache()` exported from `armorer` and `armorer/idempotency`
- [ ] `withIdempotency()` wraps individual tools with caching
- [ ] `withToolboxIdempotency()` wraps all tools in a toolbox
- [ ] `fullInputKey()`, `fieldKey()`, `compositeKey()`, `namespacedKey()` exported
- [ ] Cached results returned without re-executing the tool
- [ ] Cache respects TTL expiry
- [ ] Tool errors are NOT cached
- [ ] `onCacheHit` callback fires on cache hits
- [ ] `requireExplicitKey: true` (default) skips tools without `idempotencyKey`
- [ ] `requireExplicitKey: false` auto-generates keys for all tools
- [ ] JSON serialization order doesn't affect hash
- [ ] 100% test coverage: `bun test --coverage packages/armorer/src/idempotency/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies (uses existing Bun crypto)
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/armorer/src/idempotency/   # Idempotency tests
bun test --coverage packages/armorer/        # Coverage
turbo run check-types --filter=armorer       # Type check
turbo run lint --filter=armorer              # Lint
turbo run validate                           # Full pipeline
```

<promise>IDEMPOTENT_TOOLS_COMPLETE</promise>
<promise>IDEMPOTENT_TOOLS_FAILED</promise>
