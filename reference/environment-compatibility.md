# Environment Compatibility

## Overview

After the cross-platform crypto work removes `node:crypto` from armorer and `Bun.CryptoHasher` from skills, several other environment-specific issues remain: an unguarded `bun:sqlite` import in memory's FTS5 provider, a top-level `node:module` import in armorer's MCP integration, the gateway only working on Bun, missing `browser` export conditions in package.json files, and Bun-specific APIs in skills' directory scanner.

This work fixes all remaining cross-environment issues so agent-bureau runs correctly in Bun, Node.js, browsers, service workers, and Chrome extensions.

## What Exists Today

Read these files to understand the current state:

- `packages/memory/src/fts5-text-search-provider.ts` — unguarded `await import('bun:sqlite')` (crashes non-Bun)
- `packages/memory/src/create-sqlite-memory.ts` — wires FTS5 provider without checking availability
- `packages/armorer/src/integrations/mcp/index.ts:1` — `import { createRequire } from 'node:module'` (top-level, breaks browser bundlers)
- `packages/armorer/src/integrations/mcp/index.ts:505-508` — `defaultMcpLoader` uses `createRequire` synchronously
- `packages/gateway/src/create-gateway.ts:2` — `import { serveStatic } from 'hono/bun'` (Bun-only)
- `packages/gateway/src/create-gateway.ts:54` — `Bun.serve()` (Bun-only)
- `packages/gateway/src/server/render.tsx:14` — `Bun.file()` (Bun-only)
- `packages/gateway/src/types.ts` — `GatewayOptions` (no runtime option)
- `packages/skills/src/ingestion/scan-directory.ts` — uses `Bun.file()` alongside `node:fs/promises`
- `packages/interoperability/package.json` — no `browser` export condition
- `packages/armorer/package.json` — no `browser` export condition
- `packages/storage/src/resolve.ts` — resolver already handles multi-environment gracefully

## Product Requirements

### PR-1: FTS5 Availability Guard

Add a runtime check before importing `bun:sqlite` in the FTS5 text search provider:

```typescript
function isFts5Available(): boolean {
  return typeof globalThis.Bun !== 'undefined';
}
```

Export this from the memory package. Guard the `init()` method in `Fts5TextSearchProvider` so it throws a descriptive error if called in a non-Bun environment. Update `create-sqlite-memory.ts` to skip FTS5 wiring when unavailable, falling back to the BM25 text search that's already implemented in pure TypeScript.

### PR-2: MCP Integration Isolation

Move the `node:module` import behind a dynamic import so bundlers targeting browsers don't pull it in:

```typescript
// Before (breaks browser bundlers):
import { createRequire } from 'node:module';
const defaultMcpLoader = (): McpSdk => {
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/server/mcp.js') as McpSdk;
};

// After (browser-safe):
const defaultMcpLoader = async (): Promise<McpSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/server/mcp.js') as McpSdk;
};
```

This makes `defaultMcpLoader` async. Propagate async to `requireMcp()` and its callers within the file. MCP server creation is already async in the MCP SDK, so this is a natural fit.

### PR-3: Gateway Node.js Compatibility

The gateway uses Hono, which is runtime-agnostic. The coupling to Bun is only in `start()` (`Bun.serve()`), static file serving (`hono/bun`), and manifest loading (`Bun.file()`). Fix by:

**Server adapter pattern:**

```typescript
interface ServerAdapter {
  serve(app: Hono, options: { port: number; hostname?: string; wsHandler?: WebSocketHandler }): { stop(): void };
}
```

Create two adapters:
- `gateway/src/adapters/bun-adapter.ts` — wraps `Bun.serve()` and `serveStatic` from `hono/bun`
- `gateway/src/adapters/node-adapter.ts` — uses `@hono/node-server` and `serveStatic` from `@hono/node-server/serve-static`

**Runtime detection:**

```typescript
interface GatewayOptions {
  // ... existing fields
  /** Server runtime. Default: auto-detected. */
  runtime?: 'bun' | 'node';
}
```

Auto-detection: `typeof Bun !== 'undefined' ? 'bun' : 'node'`.

**Manifest loading:** Replace `Bun.file(manifestPath)` in `render.tsx` with `readFile` from `node:fs/promises`. Bun fully supports `node:fs/promises`, so this is backward-compatible.

### PR-4: Conditional Package Exports

Add `"browser"` condition to `package.json` exports for packages that should work in browsers. After the cross-platform crypto work, these packages have no top-level `node:*` imports:

```json
{
  ".": {
    "bun": "./src/index.ts",
    "browser": "./dist/index.js",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs",
    "default": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
}
```

Packages to update: `interoperability`, `armorer`, `storage`, `memory`, `conversationalist`, `lifecycle`, `operative`, `sentinel`, `herald`.

Packages to skip (server-only by design): `gateway`, `integration`.

### PR-5: Skills Server-Only Guards

Replace `Bun.file()` calls in `scan-directory.ts` with `readFile` from `node:fs/promises` (which Bun supports natively). Add a runtime guard at the top of `scanDirectory()`:

```typescript
function assertServerRuntime(): void {
  if (typeof globalThis.Bun === 'undefined' && typeof globalThis.process === 'undefined') {
    throw new Error('scanDirectory() requires Bun or Node.js. It cannot run in browser environments.');
  }
}
```

## Architecture

### New Files

- `packages/gateway/src/adapters/bun-adapter.ts` — Bun server adapter
- `packages/gateway/src/adapters/node-adapter.ts` — Node.js server adapter
- `packages/gateway/src/adapters/types.ts` — `ServerAdapter` interface

### Extended Files

- `packages/memory/src/fts5-text-search-provider.ts` — add `isFts5Available()` guard
- `packages/memory/src/create-sqlite-memory.ts` — skip FTS5 when unavailable
- `packages/memory/src/index.ts` — export `isFts5Available`
- `packages/armorer/src/integrations/mcp/index.ts` — make `defaultMcpLoader` async, move `node:module` behind dynamic import
- `packages/gateway/src/create-gateway.ts` — use server adapter pattern
- `packages/gateway/src/server/render.tsx` — replace `Bun.file()` with `readFile`
- `packages/gateway/src/types.ts` — add `runtime` to `GatewayOptions`
- `packages/gateway/package.json` — add `@hono/node-server` as optional peer dependency
- `packages/skills/src/ingestion/scan-directory.ts` — replace `Bun.file()`, add runtime guard
- 9 `package.json` files — add `browser` export condition

## Implementation Order (TDD)

### Phase 1: FTS5 Availability Guard

1. Write tests:
   - `isFts5Available()` returns `true` in Bun
   - `Fts5TextSearchProvider.init()` throws descriptive error when `isFts5Available()` would return false (mock the check)
   - `createSqliteMemory()` works without FTS5 when unavailable (falls back gracefully)
   - Existing FTS5 tests still pass in Bun
2. Add guard to `fts5-text-search-provider.ts`
3. Update `create-sqlite-memory.ts` to check before wiring FTS5
4. Verify: `bun test packages/memory/`

### Phase 2: MCP Integration Isolation

1. Write tests:
   - `requireMcp()` still loads MCP SDK correctly (now async)
   - `useMcpLoader()` still allows custom loaders
   - `createMcpServer()` still works end-to-end
   - Existing MCP tests pass unchanged
2. Make `defaultMcpLoader` async, move `node:module` behind dynamic import
3. Propagate async to `requireMcp()` and callers
4. Verify: `bun test packages/armorer/` (specifically MCP tests)

### Phase 3: Gateway Server Adapters

1. Write tests for Bun adapter:
   - Creates server on configured port
   - `stop()` shuts down cleanly
   - Static file serving works
   - WebSocket upgrade works
2. Write tests for Node adapter:
   - Creates server on configured port
   - `stop()` shuts down cleanly
   - Static file serving works
3. Write tests for runtime auto-detection:
   - Bun detected when `typeof Bun !== 'undefined'`
   - Falls back to Node adapter otherwise
   - Explicit `runtime: 'node'` overrides auto-detection
4. Extract `start()` to use adapter pattern
5. Replace `Bun.file()` in `render.tsx` with `readFile`
6. Verify: `bun test packages/gateway/`

### Phase 4: Conditional Package Exports

1. Update 9 `package.json` files with `"browser"` condition
2. Verify builds: `turbo run build`
3. Verify types: `turbo run check-types`
4. No tests needed — this is metadata-only

### Phase 5: Skills Server-Only Guards

1. Write tests:
   - `scanDirectory()` throws in non-server environment (mock `globalThis`)
   - `scanDirectory()` still works normally in Bun
   - Results unchanged after `Bun.file()` → `readFile` migration
2. Replace `Bun.file()` with `readFile` from `node:fs/promises`
3. Add `assertServerRuntime()` guard
4. Verify: `bun test packages/skills/`

### Phase 6: Full Integration

1. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `isFts5Available()` exported from `memory` package
- [ ] FTS5 provider throws descriptive error in non-Bun environments
- [ ] `createSqliteMemory()` gracefully falls back when FTS5 unavailable
- [ ] No top-level `import { createRequire } from 'node:module'` in armorer MCP
- [ ] `requireMcp()` is async and works correctly
- [ ] Gateway works on both Bun and Node.js via adapter pattern
- [ ] `GatewayOptions.runtime` accepts `'bun' | 'node'` with auto-detection default
- [ ] `Bun.file()` removed from `render.tsx` (replaced with `readFile`)
- [ ] `@hono/node-server` listed as optional peer dependency in gateway
- [ ] 9 packages have `"browser"` condition in `package.json` exports
- [ ] `Bun.file()` removed from `scan-directory.ts` (replaced with `readFile`)
- [ ] `scanDirectory()` throws descriptive error in non-server environments
- [ ] All existing tests pass unchanged
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new required runtime dependencies (Node adapter is optional peer dep)
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/memory/                       # FTS5 guard tests
bun test packages/armorer/                      # MCP isolation tests
bun test packages/gateway/                      # Gateway adapter tests
bun test packages/skills/                       # Skills guard tests
turbo run build                                 # Verify all packages build
turbo run check-types                           # Verify type safety
turbo run validate                              # Full pipeline
# Verify no top-level node:module import:
grep "^import.*from 'node:module'" packages/armorer/src/integrations/mcp/index.ts
# Should return nothing
# Verify Bun.file removed from gateway render:
grep "Bun.file" packages/gateway/src/server/render.tsx
# Should return nothing
```

<promise>ENVIRONMENT_COMPATIBILITY_COMPLETE</promise>
<promise>ENVIRONMENT_COMPATIBILITY_FAILED</promise>
