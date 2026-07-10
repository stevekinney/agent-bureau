# Cloudflare

`cloudflare` supplies Cloudflare Workers storage adapters for Agent Bureau deployments: a `MemoryRecordStorage` implementation for `memory`, a Weft `Storage` adapter (and therefore a `ConditionalTextValueStore`) for `operative`'s session store, and an R2-backed `TextValueStore` for `skills` and other large-text content — plus the small TypeScript contracts for the SQL, Vectorize, and R2 bindings each adapter expects.

## What It Does

- Provides `createCloudflareMemoryRecordStorage()` for Workers-hosted memory (Durable Object SQLite canonical store + Vectorize secondary index).
- Provides `createCloudflareSqliteStorage()`, a Weft `Storage` adapter over Durable Object SQLite — the Workers-native backend for `operative`'s session store (wrap it in Weft's `textValueStore()`) or anywhere else a Weft `Storage` is needed.
- Provides `createCloudflareR2TextValueStore()`, an R2-backed `TextValueStore` for `skills`'s `createStorageSkillProvider` and other large text content (tool outputs, bundled resources) that would blow past a KV/SQLite row-size budget.
- Exposes minimal `Sql`, `VectorizeIndex`, and `R2Bucket` interfaces so tests and production bindings share one contract.
- Includes package-local test helpers through `cloudflare/test`.

## How It Works

`createCloudflareMemoryRecordStorage({ sql, vectorize })` returns the same `MemoryRecordStorage` interface consumed by `memory.createMemory()`. The adapter writes full memory records to Durable Object SQLite, stores only server-owned lookup metadata in Vectorize, and rehydrates vector search hits from SQLite before returning content.

That rehydration step is the important safety boundary: Vectorize is used for candidate lookup, but SQLite decides whether a record is active, belongs to the requested tenant and namespace, and still matches the indexed version. Deletions write tombstones to SQLite before removing vector entries, so stale Vectorize results cannot surface deleted content.

`createCloudflareSqliteStorage({ sql })` returns a Weft `Storage` — the same interface Weft's built-in `MemoryStorage`/`BunSQLiteStorage`/etc. implement — backed by one `(key, value)` table in Durable Object SQLite. It passes Weft's own adapter-conformance suites (`@lostgradient/weft/storage/testing`), including `conditionalBatch` (compare-and-swap). Wrap it with Weft's `textValueStore()` to get a `ConditionalTextValueStore`, which is exactly what `operative`'s `createSessionStore` requires — so agent sessions can live in a Durable Object with no other code changes.

`createCloudflareR2TextValueStore({ bucket })` returns a plain (non-conditional) `TextValueStore`, matching what `skills`'s `createStorageSkillProvider` actually calls (`get`/`set`/`delete`/`list` — never `conditionalBatch`). R2 has no native multi-key compare-and-swap, so this is an honest, tighter surface than a full Weft `Storage`; `list()`/`deletePrefix()` follow R2's `cursor` pagination internally.

## Project Role

The `memory` package owns the memory API and retrieval behavior; `operative` owns the session-store API; `skills` owns the skill-provider API. `cloudflare` owns Workers-specific persistence backends for all three. This lets `operative`, `skills`, and `gateway` run against the same runtime configuration whether the storage backend is Weft's local SQLite, an in-memory test double, or Cloudflare infrastructure.

## Quick Start

> [!NOTE]
> This is a private, monorepo-internal package named `cloudflare` and resolved via `workspace:*`. The `cloudflare` import specifier below refers to it — not the public `cloudflare` npm package (Cloudflare's official SDK), which is unrelated and has a different API.

Wire the storage adapter into `memory.createMemory()` inside a Cloudflare Worker. The `sql` binding is `ctx.storage.sql` from your Durable Object; the `vectorize` binding comes from your Worker's env.

```typescript
import { createCloudflareMemoryRecordStorage } from 'cloudflare';
import { createMemory } from 'memory';

// Inside a Durable Object class that has a Vectorize binding in its env:
export class MemoryDurableObject {
  private readonly memory: ReturnType<typeof createMemory>;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: {
      MEMORY_INDEX: VectorizeIndex;
      embed: (texts: string[]) => Promise<number[][]>;
    },
  ) {
    const storage = createCloudflareMemoryRecordStorage({
      sql: ctx.storage.sql,
      vectorize: env.MEMORY_INDEX,
    });
    // `createMemory` requires both an embedder and a storage backend.
    this.memory = createMemory({ embedder: env.embed, storage });
  }

  async fetch(request: Request): Promise<Response> {
    await this.memory.init(); // creates the SQLite table on first request
    // ...use this.memory...
    return new Response('ok');
  }
}
```

The real `ctx.storage.sql` and your Vectorize binding both satisfy the `Sql` and `VectorizeIndex` interfaces structurally—no adapter code needed.

### Sessions: a Workers-native session store

Wire `createCloudflareSqliteStorage` into `operative`'s `createSessionStore` through Weft's `textValueStore()`:

```typescript
import { textValueStore } from '@lostgradient/weft/storage/text-value-store';
import { createCloudflareSqliteStorage } from 'cloudflare';
import { createSessionStore } from 'operative';

export class SessionDurableObject {
  private readonly sessions: ReturnType<typeof createSessionStore>;

  constructor(private readonly ctx: DurableObjectState) {
    const storage = createCloudflareSqliteStorage({ sql: ctx.storage.sql });
    // `disposeUnderlyingStorage: false` — the DO owns `ctx.storage.sql`, not us.
    this.sessions = createSessionStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    // ...this.sessions.save(session) / .load(id) / .update(id, updater)...
    return new Response('ok');
  }
}
```

`createCloudflareSqliteStorage` passes Weft's shared adapter-conformance suites (basic contract, capability row, concurrent compare-and-swap, binary round-trips) and is exercised end-to-end through `createSessionStore` in `test/sqlite-session-store-integration.test.ts` — save/load, the compare-and-swap `update()` path, and `list()`.

### Skills and large tool outputs: an R2-backed text-value store

Wire `createCloudflareR2TextValueStore` into `skills`'s `createStorageSkillProvider`:

```typescript
import { createCloudflareR2TextValueStore } from 'cloudflare';
import { createStorageSkillProvider } from 'skills';

export interface Env {
  SKILLS_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = createCloudflareR2TextValueStore({ bucket: env.SKILLS_BUCKET });
    const skills = createStorageSkillProvider(store);
    // ...skills.listSkills() / .loadSkill(name) / .loadResource(name, path)...
    return new Response('ok');
  },
};
```

The same store works for large tool-call outputs that should not live in a session's SQLite row: write the output under its own key (e.g. `tool-output:{runId}:{callId}`) and store a reference, not the content, on the session/checkpoint.

## Deploying a Bureau agent to Workers

**What works today.** A stateless agent — request in, `bureau.run()`, response out, no `ctx.sleep`, no scheduled/durable runs — can deploy to Workers now: `createCloudflareSqliteStorage` (sessions), `createCloudflareR2TextValueStore` (skills/large outputs), and `createCloudflareMemoryRecordStorage` (memory) cover every storage seam `operative`/`skills`/`memory` need outside of Weft's durable `Engine`. This package's own test suite proves each adapter against the real contract the consuming package expects (Weft's `Storage` conformance suite; `createSessionStore`; `createStorageSkillProvider`).

**What's blocked: `operative`'s durable run engine.** `createRunEngine` (used whenever a bureau is configured with `durableExecution: true` or a persistent backend) builds a Weft `Engine`, and the `Engine`'s scheduler and housekeeping are `setInterval`-driven poll loops, not one-shot timers:

- the durable-timer scheduler (`ctx.sleep(...)`, `engine.schedule(...)`) polls storage on `schedulerPollIntervalMs`;
- a checkpoint-cleanup interval runs every 60 seconds;
- a second-instance-liveness heartbeat runs on its own interval.

All three need a process that keeps running between requests. A Cloudflare Worker's execution context ends when its request finishes — timers started during a `fetch()` handler do not persist to the next invocation. Durable Objects CAN stay warm across requests, but Cloudflare's own guidance is that `setInterval`/`setTimeout` are not guaranteed to fire while a Durable Object is idle; the platform-native durable-timer primitive is a single one-shot `ctx.storage.setAlarm()`, not a poll loop. Weft's scheduler does not target the alarm API today, so there is no way to keep `ctx.sleep`/durable timers firing on Workers without changes on Weft's side.

This is a **real, verified blocker**, not a stand-in for "we didn't get to it": [`packages/operative/src/durable/create-run-engine.ts`](../operative/src/durable/create-run-engine.ts) calls `Engine.create` unconditionally when a durable engine is built, and Weft's `core/engine/index.js` starts the scheduler poller and the two `setInterval` housekeeping loops from inside that same call — there is no flag to swap in an alarm-driven scheduler.

**Weft's browser tier is not a fallback path either.** Weft explicitly supports two environment classes — Node/Bun (stable) and browsers (Web Worker + Service Worker + IndexedDB, marked **Experimental** in Weft's own compatibility table, gated behind a `browser-smoke` CI job that has not gone required). Cloudflare Workers (`workerd`) is neither: it has no `new Worker(...)`, no `ServiceWorker`, and no `IndexedDB`. So even Weft's least-stable existing tier doesn't run on Workers unmodified — this isn't a "just use the experimental build" situation.

**What would unblock it** (tracked upstream, not solved here): Weft would need a scheduler backend driven by external ticks — a Durable Object `alarm()` handler or a Workers Cron Trigger calling into `engine.tick()`/equivalent — instead of an in-process `setInterval`. Filed as `weft` task `bdfde501-f461-4011-b11d-1aedb2dd9ae8` ("Scheduler: alarm/tick-driven mode for environments without long-lived setInterval") so the fix lands in the dependency rather than being worked around here (see `CLAUDE.md`'s "Filing Work in Upstream Dependencies").

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```

---

## Public Entry Points

- `cloudflare`: `createCloudflareMemoryRecordStorage`, `createCloudflareSqliteStorage`, `createCloudflareR2TextValueStore`, storage options, and SQL, Vectorize, and R2 types.
- `cloudflare/test`: package-local testing utilities.

---

## `cloudflare` — Main Entry Point

```typescript
import { createCloudflareMemoryRecordStorage, DEFAULT_MEMORY_TABLE_NAME } from 'cloudflare';
import type {
  CreateCloudflareMemoryRecordStorageOptions,
  Sql,
  SqlCursor,
  SqlValue,
  VectorizeIndex,
  VectorizeMatch,
  VectorizeMetadataValue,
  VectorizeQueryOptions,
  VectorizeQueryResult,
  VectorizeUpsertVector,
} from 'cloudflare';
```

### `createCloudflareMemoryRecordStorage(options): MemoryRecordStorage`

Creates a `MemoryRecordStorage` backed by Cloudflare Durable Object SQLite (canonical store) and Vectorize (secondary index). The returned value satisfies the `MemoryRecordStorage` interface from the `memory` package and can be passed directly to `createMemory({ storage })`.

```typescript
function createCloudflareMemoryRecordStorage(
  options: CreateCloudflareMemoryRecordStorageOptions,
): MemoryRecordStorage;

interface CreateCloudflareMemoryRecordStorageOptions {
  /** Durable Object SQLite binding (`ctx.storage.sql`) or a test double. */
  sql: Sql;
  /** Vectorize binding from Worker env, or a test fake. */
  vectorize: VectorizeIndex;
  /**
   * SQLite table name. Defaults to `'memory_records'` (`DEFAULT_MEMORY_TABLE_NAME`).
   * Provide a custom name when multiple logical stores share one Durable Object.
   * Must be a valid SQL identifier (letters, digits, underscore; must start with a letter or underscore, not a digit).
   */
  tableName?: string;
}
```

**Security invariants** enforced by the implementation:

- `tenantId` must be a non-empty string on every scoped operation.
- Vectorize metadata is server-owned and allowlisted to `{ tenant_id, namespace, memory_id, created_at, version }`—caller content is never written to the secondary index.
- Every `searchByVector` hit is rehydrated from SQLite and re-scoped before being returned. Vectorize's own filter is never trusted as the security boundary.
- Delete is a tombstone-first operation: `status = 'deleted'` is written in SQLite _before_ the id is removed from Vectorize.

### `DEFAULT_MEMORY_TABLE_NAME`

```typescript
const DEFAULT_MEMORY_TABLE_NAME = 'memory_records';
```

The default SQLite table name used when `tableName` is omitted from options.

---

### `Sql` interface

The minimal SQL surface the backend needs. The real `ctx.storage.sql` from a Durable Object satisfies this structurally with no adapter.

```typescript
type SqlValue = string | number | null;

interface SqlCursor<Row extends Record<string, SqlValue>> {
  toArray(): Row[];
}

interface Sql {
  exec<Row extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row>;
}
```

---

### `VectorizeIndex` interface and related types

The minimal Vectorize surface the backend needs. The real Vectorize binding from a Worker env satisfies this structurally.

```typescript
type VectorizeMetadataValue = string | number | boolean;

interface VectorizeUpsertVector {
  id: string;
  values: number[];
  metadata: Record<string, VectorizeMetadataValue>;
}

interface VectorizeQueryOptions {
  topK: number;
  filter: Record<string, VectorizeMetadataValue>;
  returnMetadata: boolean;
}

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, VectorizeMetadataValue>;
}

interface VectorizeQueryResult {
  matches: VectorizeMatch[];
}

interface VectorizeIndex {
  upsert(vectors: VectorizeUpsertVector[]): Promise<void>;
  query(vector: number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
  deleteByIds(ids: string[]): Promise<void>;
}
```

---

### `createCloudflareSqliteStorage(options): Storage`

Creates a Weft `Storage` adapter backed by Cloudflare Durable Object SQLite. Wrap the result in Weft's `textValueStore()` to satisfy `operative`'s `ConditionalTextValueStore`-typed session store, or use it directly wherever a Weft `Storage` is expected.

```typescript
function createCloudflareSqliteStorage(options: CreateCloudflareSqliteStorageOptions): Storage;

interface CreateCloudflareSqliteStorageOptions {
  /** Durable Object SQLite binding (`ctx.storage.sql`) or a test double. */
  sql: Sql;
  /**
   * SQLite table name. Defaults to `'kv_store'` (`DEFAULT_SQLITE_STORAGE_TABLE_NAME`).
   * Provide a custom name when multiple logical stores share one Durable Object.
   * Must be a valid SQL identifier (letters, digits, underscore; must start with a letter or underscore, not a digit).
   */
  tableName?: string;
}
```

**Capabilities reported by `storage.capabilities()`:** `persistence: 'local'`, `readAfterWrite: 'linearizable'`, `scanConsistency: 'snapshot'`, `atomicBatch: true`, `conditionalBatch: true`, `boundedRangeDelete: true`. Verified, not just claimed: `test/sqlite-storage-contract.test.ts` runs Weft's `runStorageCapabilityConformance` suite, which behaviorally checks each claim, plus `runBasicStorageContract`, `runConcurrentConditionalBatchConformance`, and `runBinaryAndLargeScanStorageConformance`.

`conditionalBatch` never applies a partial write: every precondition is checked before any operation runs, so a failed compare-and-swap leaves storage untouched with no explicit transaction needed. Values are stored as base64 TEXT (not BLOB) so this adapter shares the same minimal `Sql` contract as `createCloudflareMemoryRecordStorage`.

### `DEFAULT_SQLITE_STORAGE_TABLE_NAME`

```typescript
const DEFAULT_SQLITE_STORAGE_TABLE_NAME = 'kv_store';
```

The default SQLite table name used when `tableName` is omitted from `createCloudflareSqliteStorage` options.

---

### `createCloudflareR2TextValueStore(options): TextValueStore`

Creates a Weft `TextValueStore` backed by a Cloudflare R2 bucket — the store `skills`'s `createStorageSkillProvider` expects, and a natural place for large tool outputs.

```typescript
function createCloudflareR2TextValueStore(
  options: CreateCloudflareR2TextValueStoreOptions,
): TextValueStore;

interface CreateCloudflareR2TextValueStoreOptions {
  /** R2 bucket binding from Worker env, or a test fake. */
  bucket: R2Bucket;
}
```

`list(prefix)` and `deletePrefix(prefix)` both follow R2's `cursor` pagination internally, so callers never see a partial page. This is intentionally a plain `TextValueStore`, not a `ConditionalTextValueStore`: R2 has no native multi-key compare-and-swap, and `createStorageSkillProvider` never calls `conditionalBatch`. Use `createCloudflareSqliteStorage` instead for anything that needs compare-and-swap.

### `R2Bucket` interface and related types

The minimal R2 surface the backend needs. The real R2 binding from a Worker env satisfies this structurally, verified against `@cloudflare/workers-types`: `get(key)` without an `onlyIf` option resolves to the `R2ObjectBody | null` overload, and `put`'s return type is `Promise<unknown>` (not `Promise<void>`) specifically because the real `R2Bucket.put` resolves to `R2Object | null` — `Promise<X>` is not assignable to `Promise<void>` for non-`void` `X`, so a `Promise<void>` signature here would have rejected the real binding.

```typescript
interface R2ObjectBody {
  text(): Promise<string>;
}

interface R2ObjectMetadata {
  key: string;
}

interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

interface R2ListResult {
  objects: R2ObjectMetadata[];
  truncated: boolean;
  cursor?: string;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: R2ListOptions): Promise<R2ListResult>;
}
```

---

## `cloudflare/test` — Test Utilities

```typescript
import {
  createCloudflareMemoryTestHarness,
  createFakeR2,
  createFakeVectorize,
  createSqliteDouble,
} from 'cloudflare/test';
import type {
  CloudflareMemoryTestHarness,
  FakeR2,
  FakeVectorize,
  PoisonHit,
  RecordedQuery,
  SqliteDouble,
} from 'cloudflare/test';
```

`createSqliteDouble()` also backs `createCloudflareSqliteStorage` in tests — it satisfies the same `Sql` interface, so `createCloudflareSqliteStorage({ sql: createSqliteDouble() })` exercises the real SQL the Durable Object binding would run.

### `createFakeR2(options?): FakeR2`

A recording, in-memory `R2Bucket` fake. Unlike the real binding it can't exist under `bun:test`, so `createCloudflareR2TextValueStore` takes an injectable `R2Bucket`; this fake satisfies that interface with a `Map`, and paginates `list()` in fixed-size pages (default 3, override via `options.pageSize`) even though the whole bucket fits in memory — so tests exercise the adapter's real cursor-follow loop, not a single-page shortcut.

```typescript
function createFakeR2(options?: { pageSize?: number }): FakeR2;

interface FakeR2 extends R2Bucket {
  /** Every key passed to `get`, in order. */
  readonly getCalls: string[];
  /** Every `[key, value]` pair passed to `put`, in order. */
  readonly putCalls: ReadonlyArray<readonly [string, string]>;
  /** Every key passed to `delete`, in order. */
  readonly deleteCalls: string[];
  /** Every options object passed to `list`, in order. */
  readonly listCalls: R2ListOptions[];
}
```

### `createCloudflareMemoryTestHarness(options?): CloudflareMemoryTestHarness`

The primary test entry point. Creates a fresh `bun:sqlite` double and an adversarial Vectorize fake, wires them together into a `createCloudflareMemoryRecordStorage` instance, and returns all three so tests can assert both observable behavior and secondary-index interactions.

```typescript
function createCloudflareMemoryTestHarness(
  options?: Omit<CreateCloudflareMemoryRecordStorageOptions, 'sql' | 'vectorize'>,
): CloudflareMemoryTestHarness;

interface CloudflareMemoryTestHarness {
  /** The backend under test, wired to `sql` and `vectorize`.
   *  `MemoryRecordStorage` is the contract type from the `memory` package. */
  storage: MemoryRecordStorage;
  /** The bun:sqlite-backed canonical store double. */
  sql: SqliteDouble;
  /** The recording, adversarial Vectorize fake. */
  vectorize: FakeVectorize;
}
```

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { createCloudflareMemoryTestHarness } from 'cloudflare/test';

describe('Cloudflare memory backend', () => {
  let harness: ReturnType<typeof createCloudflareMemoryTestHarness>;

  afterEach(() => harness.sql.close());

  it('stores and retrieves a memory record', async () => {
    harness = createCloudflareMemoryTestHarness();
    const { storage } = harness;

    await storage.init();
    await storage.put({
      id: 'rec-1',
      tenantId: 'tenant-a',
      namespace: 'notes',
      content: 'Hello world',
      vector: new Float32Array([0.1, 0.2, 0.3]),
      metadata: {},
      status: 'active',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const record = await storage.get('rec-1', {
      tenantId: 'tenant-a',
      namespace: 'notes',
    });

    expect(record?.content).toBe('Hello world');
    // The backend also upserted the vector into Vectorize:
    expect(harness.vectorize.upsertCalls).toHaveLength(1);
  });
});
```

Use a custom `tableName` to isolate tests that share a process:

```typescript
harness = createCloudflareMemoryTestHarness({ tableName: 'test_memory' });
```

---

### `createSqliteDouble(): SqliteDouble`

Creates a `bun:sqlite`-backed `Sql` double over an in-memory database. Use this when you want to wire the backend manually rather than through `createCloudflareMemoryTestHarness`.

```typescript
function createSqliteDouble(): SqliteDouble;

interface SqliteDouble extends Sql {
  /** Close and release the underlying in-memory database. Call in `afterEach`. */
  close(): void;
}
```

---

### `createFakeVectorize(): FakeVectorize`

Creates a recording, adversarial `VectorizeIndex` fake. `query()` scores stored vectors with cosine similarity, applies metadata filters, and supports injected poison hits—so tests can prove the backend's rehydration logic drops cross-tenant, stale-version, deleted, and absent hits.

```typescript
function createFakeVectorize(): FakeVectorize;

interface FakeVectorize extends VectorizeIndex {
  /** Every upsert call's vectors, in order. */
  readonly upsertCalls: VectorizeUpsertVector[][];
  /** Every query call's vector and options, in order. */
  readonly queryCalls: RecordedQuery[];
  /** Every deleteByIds call's id list, in order. */
  readonly deleteCalls: string[][];
  /** Flat ordered log of all call kinds ('upsert' | 'query' | 'delete'), in invocation order. */
  readonly callLog: ReadonlyArray<'upsert' | 'query' | 'delete'>;
  /**
   * Splice poison hits into the front of the NEXT query result.
   * Cleared after that one query. Use to prove rehydration drops bad hits.
   */
  injectPoison(hits: PoisonHit[]): void;
}

/** A poison hit to inject into a query result. */
interface PoisonHit {
  id: string;
  score: number;
  metadata?: Record<string, VectorizeMetadataValue>;
}

/** A recorded VectorizeIndex.query invocation. */
interface RecordedQuery {
  vector: number[];
  options: VectorizeQueryOptions;
}
```

```typescript
import { describe, it, expect } from 'bun:test';
import { createCloudflareMemoryTestHarness } from 'cloudflare/test';

it('drops a poison cross-tenant hit during vector search', async () => {
  const { storage, vectorize, sql } = createCloudflareMemoryTestHarness();
  await storage.init();

  // Upsert a real record.
  await storage.put({
    id: 'rec-1',
    tenantId: 'tenant-a',
    namespace: 'notes',
    content: 'Real content',
    vector: new Float32Array([1, 0, 0]),
    metadata: {},
    status: 'active',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Inject a poison hit that claims to belong to a different tenant.
  vectorize.injectPoison([
    {
      id: 'cross-tenant-id',
      score: 0.99, // higher score than the real record
      metadata: { tenant_id: 'evil', namespace: 'notes', memory_id: 'rec-99', version: 1 },
    },
  ]);

  const results = await storage.searchByVector(
    new Float32Array([1, 0, 0]),
    { tenantId: 'tenant-a', namespace: 'notes' },
    { limit: 5 },
  );

  // The poison hit is dropped; only the real record survives rehydration.
  expect(results).toHaveLength(1);
  expect(results[0]?.id).toBe('rec-1');

  sql.close();
});
```
