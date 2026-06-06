---
"memory": major
"interoperability": minor
---

Remove the SQLite-backed memory storage surface and delete the `vector-frankl` package.

**New public API (`interoperability`)**

- Added embedding vector helpers: `cosineSimilarity`, `isEmbeddingVector`,
  `computeEmbeddingVectorMagnitude`, and the `EmbeddingVectorLike` type. These are the single
  source of truth for vector math, consumed by `memory`.

**Breaking changes**

- Removed `createSQLiteMemory`. Construct memory with `createMemory` and a Weft-backed
  `MemoryRecordStorage` instead.
- Removed `SQLiteStorageAdapter`. Record persistence now goes through `MemoryRecordStorage`,
  built on Weft's durable storage.
- Removed `createFts5TextSearchProvider` and `isFts5Available`. Full-text search no longer
  depends on SQLite FTS5; use the in-package BM25 text search provider.
- `CreateMemoryOptions.storage` now accepts a `MemoryRecordStorage` rather than a SQLite
  storage adapter.
- Deleted the `vector-frankl` package entirely. It is no longer part of the workspace and is
  not consumed by any package.

**Migration**

Replace `createSQLiteMemory({ ... })` call sites with `createMemory` plus a
`MemoryRecordStorage` (see `createWeftMemoryRecordStorage`). Drop any imports of
`SQLiteStorageAdapter`, `createFts5TextSearchProvider`, or `isFts5Available`.
