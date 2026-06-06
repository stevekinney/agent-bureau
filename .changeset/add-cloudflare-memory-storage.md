---
"cloudflare": minor
---

Add the `cloudflare` package: a `MemoryRecordStorage` backend on Cloudflare, with
Durable Object SQLite as the canonical store and Vectorize as a secondary vector
index.

- `createCloudflareMemoryRecordStorage({ sql, vectorize, tableName? })` implements
  the `memory` `MemoryRecordStorage` contract. The SQL and Vectorize surfaces are
  injected, so the backend runs under `bun:test` against a `bun:sqlite` double and
  a fake Vectorize binding; production wires the Durable Object `ctx.storage.sql`
  binding and a real Vectorize binding.
- `tenantId` is required and supplied by Worker-side authenticated code. Reads go
  to active SQLite rows; `searchByVector` queries Vectorize under a server-owned
  tenant + namespace filter, then rehydrates every hit from canonical SQLite —
  identity comes from the scope-encoded Vectorize id, never from the hit's
  metadata. Delete writes a SQLite tombstone before removing the Vectorize entry.
- The package runs the shared `MemoryRecordStorage` contract suite (extracted from
  `memory` into `memory/test/contract-harness`), so it satisfies the identical
  observable contract the local backends do.

`memory` exposes a new non-built `./test/contract-harness` subpath
(`runMemoryRecordStorageContract`) so other packages can run the shared suite
against their own backends.
