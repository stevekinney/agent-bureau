# Cross-Platform Crypto

## Overview

Three packages use environment-specific cryptographic hashing in production code:

- **armorer** imports `createHash` from `node:crypto` in `create-tool.ts` and `loop-detection.ts`. This breaks in browsers, service workers, and Chrome extensions.
- **skills** uses `Bun.CryptoHasher` in `proposals.ts`. This breaks in Node.js, browsers, service workers, and Chrome extensions.
- **memory** has a cross-platform `sha256Hex()` using `crypto.subtle.digest()` in `hash.ts`, but it's not shared—other packages duplicate the work with incompatible APIs.

This work creates shared hashing utilities in the `interoperability` package (the lowest-level shared package, zero runtime deps) and migrates all consumers.

## What Exists Today

Read these files to understand the current state:

- `packages/interoperability/src/index.ts` — current exports (types and materialization only)
- `packages/interoperability/package.json` — zero runtime deps, depended on by armorer, memory, operative, herald, conversationalist
- `packages/armorer/src/create-tool.ts:1` — `import { createHash } from 'node:crypto'`, used at line 814 (`createStreamingAccumulator` — incremental hashing) and line 1504 (`computeDigest` — one-shot hash)
- `packages/armorer/src/core/loop-detection.ts:1` — `import { createHash } from 'node:crypto'`, used at line 102 (`defaultHashFunction` — one-shot hash)
- `packages/skills/src/self-improvement/proposals.ts:55` — `new Bun.CryptoHasher('sha256').update(content).digest('hex')`
- `packages/memory/src/hash.ts` — `sha256Hex()` using `crypto.subtle.digest()` (async, works everywhere)

## The Sync/Async Problem

`node:crypto.createHash()` and `Bun.CryptoHasher` are synchronous. `crypto.subtle.digest()` (the only hashing API available in browsers) is async. The armorer uses synchronous hashing in hot paths:

- `computeDigest()` is called during tool execution to hash inputs/outputs
- `defaultHashFunction()` is called on every `recordCall()` in loop detection
- The streaming accumulator uses `createHash()` to incrementally hash chunks

Making these async would change armorer's internal API signatures. The solution: provide _both_ sync and async utilities. The sync version works in Bun and Node.js (where `node:crypto` is available). The async version works everywhere. Callers choose based on their environment constraints.

## Product Requirements

### PR-1: Async Hash (Universal)

Lift `sha256Hex()` from `memory/src/hash.ts` into `interoperability`:

```typescript
/** Computes SHA-256 hex digest using Web Crypto API. Works in all environments. */
async function sha256Hex(text: string): Promise<string>;
```

This uses `crypto.subtle.digest('SHA-256', ...)` which is available in Bun, Node.js 15+, all modern browsers, service workers, and Chrome extensions.

### PR-2: Sync Hash (Bun + Node.js)

A synchronous version for server-side hot paths:

```typescript
/**
 * Computes SHA-256 hex digest synchronously.
 * Uses Bun.CryptoHasher when available, falls back to node:crypto.createHash.
 * Throws in browser environments — use sha256Hex() instead.
 */
function sha256HexSync(text: string): string;
```

Runtime detection order:
1. `typeof Bun !== 'undefined'` → `new Bun.CryptoHasher('sha256').update(text).digest('hex')`
2. Otherwise → dynamically cached `createHash` from `node:crypto` (resolved once via a module-level variable populated by a self-invoking async import, or eagerly if `globalThis.process` is available)
3. Neither available → throw `Error('sha256HexSync requires Bun or Node.js. Use sha256Hex() for browser environments.')`

For the Node.js fallback, use a lazy-initialized module reference:

```typescript
let nodeCreateHash: typeof import('node:crypto').createHash | undefined;

function getNodeCreateHash(): typeof import('node:crypto').createHash {
  if (!nodeCreateHash) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodeCreateHash = (require('node:crypto') as typeof import('node:crypto')).createHash;
  }
  return nodeCreateHash;
}
```

This works because Node.js supports synchronous `require()` for built-in modules. Bun also supports `require()`. In browsers, the outer `typeof Bun` check prevents reaching this path.

### PR-3: Incremental Hash (Bun + Node.js)

For armorer's streaming accumulator that calls `.update()` multiple times:

```typescript
interface IncrementalHash {
  update(data: string): void;
  digest(): string;
}

/**
 * Creates an incremental SHA-256 hasher.
 * Uses Bun.CryptoHasher when available, falls back to node:crypto.createHash.
 * Throws in browser environments.
 */
function createIncrementalHash(algorithm?: string): IncrementalHash;
```

Default algorithm: `'sha256'`.

### PR-4: Migrate Armorer

Replace `node:crypto` imports in armorer:

- `create-tool.ts:1` — remove `import { createHash } from 'node:crypto'`
- `create-tool.ts:814` — replace `createHash(digestOptions.algorithm)` with `createIncrementalHash(digestOptions.algorithm)` from `interoperability`
- `create-tool.ts:1502-1504` — replace `computeDigest` body with `sha256HexSync`
- `loop-detection.ts:1` — remove `import { createHash } from 'node:crypto'`
- `loop-detection.ts:99-102` — replace `defaultHashFunction` body with `sha256HexSync`

### PR-5: Migrate Skills

Replace `Bun.CryptoHasher` in skills:

- `proposals.ts:54-56` — replace `hashContent()` body with `sha256HexSync` from `interoperability`
- `packages/skills/package.json` — add `"interoperability": "workspace:*"` to dependencies

### PR-6: Deduplicate Memory Hash

Replace the standalone implementation in memory:

- `memory/src/hash.ts` — change to re-export `sha256Hex` from `interoperability`
- Verify `embedding-cache.ts` and any other internal consumers still work

## Architecture

### New Files

- `packages/interoperability/src/hash.ts` — `sha256Hex`, `sha256HexSync`, `createIncrementalHash`

### Extended Files

- `packages/interoperability/src/index.ts` — re-export hash utilities
- `packages/armorer/src/create-tool.ts` — replace `node:crypto` with interoperability
- `packages/armorer/src/core/loop-detection.ts` — replace `node:crypto` with interoperability
- `packages/skills/src/self-improvement/proposals.ts` — replace `Bun.CryptoHasher` with interoperability
- `packages/skills/package.json` — add interoperability dependency
- `packages/memory/src/hash.ts` — re-export from interoperability

## Implementation Order (TDD)

### Phase 1: Async Hash

1. Write tests for `sha256Hex()`:
   - Returns consistent hex string for same input
   - Returns different hex for different inputs
   - Output is 64 hex characters (SHA-256)
   - Handles empty string
   - Handles unicode text
   - Handles very long strings
2. Implement in `packages/interoperability/src/hash.ts`
3. Verify: `bun test packages/interoperability/src/hash.test.ts`

### Phase 2: Sync Hash

1. Write tests for `sha256HexSync()`:
   - Returns consistent hex string for same input
   - Returns identical output to `sha256Hex()` for same input (cross-check)
   - Output is 64 hex characters
   - Handles empty string, unicode, long strings
   - Works in Bun runtime (primary target)
2. Implement in `packages/interoperability/src/hash.ts`
3. Verify: `bun test packages/interoperability/src/hash.test.ts`

### Phase 3: Incremental Hash

1. Write tests for `createIncrementalHash()`:
   - Single `update()` + `digest()` matches `sha256HexSync()` for same input
   - Multiple `update()` calls produce same result as single call with concatenated input
   - `digest()` returns 64 hex characters
   - Separate instances are independent (no shared state)
   - Default algorithm is sha256
2. Implement in `packages/interoperability/src/hash.ts`
3. Verify: `bun test packages/interoperability/src/hash.test.ts`

### Phase 4: Migrate Armorer

1. Update `create-tool.ts`:
   - Remove `import { createHash } from 'node:crypto'`
   - Import `sha256HexSync`, `createIncrementalHash` from `interoperability`
   - Replace `computeDigest()` body
   - Replace `createStreamingAccumulator()` digest creation
2. Update `loop-detection.ts`:
   - Remove `import { createHash } from 'node:crypto'`
   - Import `sha256HexSync` from `interoperability`
   - Replace `defaultHashFunction` body
3. Run armorer tests: `bun test packages/armorer/`
4. Verify no `node:crypto` remains: `grep -r "from 'node:crypto'" packages/armorer/src/ --include='*.ts'` should return nothing

### Phase 5: Migrate Skills

1. Add `"interoperability": "workspace:*"` to `packages/skills/package.json` dependencies
2. Update `proposals.ts`:
   - Import `sha256HexSync` from `interoperability`
   - Replace `hashContent()` body
3. Run skills tests: `bun test packages/skills/`
4. Verify no `Bun.CryptoHasher` remains: `grep -r "Bun.CryptoHasher" packages/skills/src/` should return nothing

### Phase 6: Deduplicate Memory Hash

1. Update `memory/src/hash.ts` to re-export from interoperability
2. Run memory tests: `bun test packages/memory/`
3. Verify memory's consumers still work

### Phase 7: Full Integration

1. Build interoperability: `turbo run build --filter=interoperability`
2. Build dependents: `turbo run build --filter=armorer --filter=skills --filter=memory`
3. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `sha256Hex()` exported from `interoperability` — async, works in all environments
- [ ] `sha256HexSync()` exported from `interoperability` — sync, works in Bun and Node.js
- [ ] `createIncrementalHash()` exported from `interoperability` — sync incremental hasher
- [ ] `sha256HexSync()` uses `Bun.CryptoHasher` when in Bun
- [ ] `sha256HexSync()` falls back to `node:crypto.createHash` when in Node.js
- [ ] `sha256HexSync()` throws descriptive error in browser environments
- [ ] `sha256Hex()` and `sha256HexSync()` produce identical output for same input
- [ ] `createIncrementalHash()` multiple `.update()` calls match single-call equivalent
- [ ] No `import { createHash } from 'node:crypto'` in `packages/armorer/src/` (excluding tests and scripts)
- [ ] No `Bun.CryptoHasher` in `packages/skills/src/`
- [ ] `packages/memory/src/hash.ts` re-exports from `interoperability` (no duplicate implementation)
- [ ] All existing armorer tests pass unchanged
- [ ] All existing skills tests pass unchanged
- [ ] All existing memory tests pass unchanged
- [ ] 100% test coverage on `packages/interoperability/src/hash.ts`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new external runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/interoperability/             # Hash utility tests
bun test packages/armorer/                      # Armorer tests (no regressions)
bun test packages/skills/                       # Skills tests (no regressions)
bun test packages/memory/                       # Memory tests (no regressions)
turbo run check-types --filter=interoperability # Type check
turbo run check-types --filter=armorer          # Type check
turbo run check-types --filter=skills           # Type check
turbo run validate                              # Full pipeline
# Verify no node:crypto in armorer production code:
grep -r "from 'node:crypto'" packages/armorer/src/ --include='*.ts'
# Verify no Bun.CryptoHasher in skills:
grep -r "Bun.CryptoHasher" packages/skills/src/
```

<promise>CROSS_PLATFORM_CRYPTO_COMPLETE</promise>
<promise>CROSS_PLATFORM_CRYPTO_FAILED</promise>
