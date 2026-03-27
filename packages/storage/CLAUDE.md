# CLAUDE.md

This file provides guidance to Claude Code when working with the storage package.

This package lives in the `agent-bureau` monorepo under `packages/storage/`. Tasks are orchestrated via Turborepo from the monorepo root.

## Essential Commands

### From the monorepo root (preferred)

```bash
turbo run build --filter=storage        # Build this package
turbo run test --filter=storage         # Run tests
turbo run lint --filter=storage         # Lint
turbo run check-types --filter=storage  # Type-check
```

### Within this package directory

```bash
bun run build             # Build for production (outputs to dist/)
bun test                  # Run all tests
bun test --coverage       # Generate coverage report
bun run lint              # Check linting errors
bun run check-types       # TypeScript type checking
```

## Architecture

### Two Storage Layers

The monorepo has exactly two storage interfaces:

1. **`StorageAdapter`** (vector-frankl) — specialized for `Float32Array` vectors with similarity search. Not changing.
2. **`KeyValueStore`** (this package) — generic string key-value store for everything else: identity, skills, proposals, scheduler state, session persistence.

### KeyValueStore Interface

Four required methods (`get`, `set`, `delete`, `list`), three optional (`has`, `deletePrefix`, `close`). Values are opaque strings; consumers handle serialization. Keys use colon-separated hierarchical namespaces (e.g., `identity:soul:orchestrator`).

### Adapters

Each adapter is a factory function returning `KeyValueStore`:

- `createMemoryKeyValueStore` — in-memory Map, zero dependencies
- `createSQLiteKeyValueStore` — `bun:sqlite`, WAL mode, shares files with vector-frankl
- `createIndexedDBKeyValueStore` — browser IndexedDB with `IDBKeyRange` prefix scanning
- `createChromeKeyValueStore` — `chrome.storage.local` or `chrome.storage.session`
- `createRemoteKeyValueStore` — HTTP client for remote key-value API

### Namespace Wrapper

`withNamespace(store, namespace)` is the single source of truth for namespace logic. Adapters do not implement their own — factory functions that accept a `namespace` option delegate to `withNamespace`.

### Resolver

`resolveKeyValueStore(configuration)` auto-detects the best adapter: SQLite → Chrome Storage → IndexedDB → Memory.

## Key Design Decisions

- **Factory functions over classes** — consistent with the rest of the monorepo.
- **Dynamic imports** for platform-specific modules (`bun:sqlite`) — prevents load failures in non-Bun environments.
- **Zero runtime dependencies** — the core interface and memory adapter have no external deps.
- **`isAvailable()` functions** per adapter for runtime capability detection.
