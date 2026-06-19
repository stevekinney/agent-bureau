# Cloudflare

`cloudflare` supplies Cloudflare Workers storage adapters for Agent Bureau deployments. Its current public surface is a `MemoryRecordStorage` implementation for the `memory` package, plus small TypeScript contracts for the SQL and Vectorize bindings it expects.

## What It Does

- Provides `createCloudflareMemoryRecordStorage()` for Workers-hosted memory.
- Treats Durable Object SQLite as the canonical record store.
- Uses Cloudflare Vectorize as a secondary nearest-neighbor index.
- Exposes minimal `Sql` and `VectorizeIndex` interfaces so tests and production bindings share one contract.
- Includes package-local test helpers through `cloudflare/test`.

## How It Works

`createCloudflareMemoryRecordStorage({ sql, vectorize })` returns the same `MemoryRecordStorage` interface consumed by `memory.createMemory()`. The adapter writes full memory records to Durable Object SQLite, stores only server-owned lookup metadata in Vectorize, and rehydrates vector search hits from SQLite before returning content.

That rehydration step is the important safety boundary: Vectorize is used for candidate lookup, but SQLite decides whether a record is active, belongs to the requested tenant and namespace, and still matches the indexed version. Deletions write tombstones to SQLite before removing vector entries, so stale Vectorize results cannot surface deleted content.

## Project Role

The `memory` package owns the memory API and retrieval behavior. `cloudflare` owns the Workers-specific persistence backend for that API. This lets `operative` and `gateway` use memory through the same runtime configuration whether the storage backend is Weft, an in-memory test double, or Cloudflare infrastructure.

## Public Entry Points

- `cloudflare`: `createCloudflareMemoryRecordStorage`, storage options, SQL types, and Vectorize types.
- `cloudflare/test`: package-local testing utilities.

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
