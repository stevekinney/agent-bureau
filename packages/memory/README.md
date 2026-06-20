# Memory

`memory` provides persistent recall for Agent Bureau agents. It defines the memory API, storage contracts, embedding-backed retrieval, hybrid search, ingestion helpers, runtime hooks, identity primitives, and tool surfaces for storing, recalling, and forgetting memory.

## What It Does

- Creates a `Memory` instance with `remember()`, `rememberOnce()`, `recall()`, `list()`, `forget()`, and `count()`.
- Defines the `MemoryRecordStorage` contract used by Weft, Cloudflare, and test backends.
- Combines vector search, BM25 text search, temporal decay, and maximal marginal relevance.
- Supports deduplication, conflict detection, namespace isolation, and external text-search providers.
- Adds ingestion, chunking, file synchronization, reflection, run capture, and consolidation helpers.
- Provides memory tools and identity tools for use through `armorer` and `operative`.

## How It Works

`createMemory()` accepts an embedder and a storage backend. On writes, it embeds content, checks for duplicates or conflicts, persists a canonical memory record, and optionally indexes text. On recall, it gathers vector and text candidates, merges scores, applies temporal decay and diversity, and returns ranked `MemorySearchResult` entries.

The storage contract is intentionally lower level than the public memory API. Backends own durable record reads and vector lookup, while `memory` owns retrieval semantics. `createWeftMemoryRecordStorage()` is the default durable workspace backend, and `cloudflare` provides a Workers backend with the same storage contract.

## Project Role

`operative` uses memory through hooks and bridges during agent runs. `gateway` wires configured memory into the composed runtime. `skills` can use memory to persist skill usage and self-improvement context. The package is the long-term knowledge layer shared by those higher-level surfaces.

## Public Entry Points

- `createMemory()`
- `createWeftMemoryRecordStorage()`
- `createMemoryHooks()`
- `createRunCaptureHook()` and `createReflectionHook()`
- Retrieval helpers such as `mergeHybridResults()`, `computeBM25Scores()`, `applyTemporalDecay()`, and `applyMaximalMarginalRelevance()`
- Ingestion helpers such as `chunkMarkdown()`, `ingest()`, and `createFileSynchronizer()`
- Tools such as `createMemoryStoreTool()`, `createMemoryRecallTool()`, and `createMemoryForgetTool()`
- Identity helpers such as `createStorageIdentityProvider()` and `createIdentityToolbox()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
