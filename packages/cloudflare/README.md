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

## Quick Start

Wire the storage adapter into `memory.createMemory()` inside a Cloudflare Worker. The `sql` binding is `ctx.storage.sql` from your Durable Object; the `vectorize` binding comes from your Worker's env.

```typescript
import { createCloudflareMemoryRecordStorage } from 'cloudflare';
import { createMemory } from 'memory';

// Inside a Durable Object class that has a Vectorize binding in its env:
export class MemoryDurableObject {
  private readonly memory: ReturnType<typeof createMemory>;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { MEMORY_INDEX: VectorizeIndex },
  ) {
    const storage = createCloudflareMemoryRecordStorage({
      sql: ctx.storage.sql,
      vectorize: env.MEMORY_INDEX,
    });
    this.memory = createMemory({ storage });
  }

  async fetch(request: Request): Promise<Response> {
    await this.memory.storage.init(); // creates table on first request
    // ...use this.memory...
    return new Response('ok');
  }
}
```

The real `ctx.storage.sql` and your Vectorize binding both satisfy the `Sql` and `VectorizeIndex` interfaces structurally—no adapter code needed.

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```

---

## Public Entry Points

- `cloudflare`: `createCloudflareMemoryRecordStorage`, storage options, SQL types, and Vectorize types.
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
   * Must be a valid SQL identifier (letters, digits, underscore; not starting with a digit).
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

## `cloudflare/test` — Test Utilities

```typescript
import {
  createCloudflareMemoryTestHarness,
  createSqliteDouble,
  createFakeVectorize,
} from 'cloudflare/test';
import type {
  CloudflareMemoryTestHarness,
  SqliteDouble,
  FakeVectorize,
  PoisonHit,
  RecordedQuery,
} from 'cloudflare/test';
```

### `createCloudflareMemoryTestHarness(options?): CloudflareMemoryTestHarness`

The primary test entry point. Creates a fresh `bun:sqlite` double and an adversarial Vectorize fake, wires them together into a `createCloudflareMemoryRecordStorage` instance, and returns all three so tests can assert both observable behavior and secondary-index interactions.

```typescript
function createCloudflareMemoryTestHarness(
  options?: Omit<CreateCloudflareMemoryRecordStorageOptions, 'sql' | 'vectorize'>,
): CloudflareMemoryTestHarness;

interface CloudflareMemoryTestHarness {
  /** The backend under test, wired to `sql` and `vectorize`. */
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
  /** Flat ordered log of mutating call kinds ('upsert' | 'query' | 'delete'). */
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
