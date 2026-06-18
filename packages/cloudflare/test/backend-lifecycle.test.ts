import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope } from 'memory';

import {
  createCloudflareMemoryRecordStorage,
  MAX_SEARCH_LIMIT,
} from '../src/create-cloudflare-memory-record-storage';
import { createCloudflareMemoryTestHarness } from '../src/test';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble } from '../src/test/sqlite-double';

/**
 * Cloudflare-backend lifecycle behavior NOT covered by the shared contract
 * suite: `close()` is a non-owning no-op (it must NOT dispose the injected SQL /
 * Vectorize bindings, which are shared with the rest of the Worker), and the
 * test-harness wiring exposes the doubles it builds.
 */

const TENANT = 'tenant-a';
const NAMESPACE = 'alpha';
const SCOPE: MemoryRecordScope = { tenantId: TENANT, namespace: NAMESPACE };

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id,
    tenantId: TENANT,
    namespace: NAMESPACE,
    content: `content-${id}`,
    vector: new Float32Array([1, 0]),
    metadata: {},
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: 'active',
    ...overrides,
  };
}

describe('close() is a non-owning no-op', () => {
  it('leaves the injected SQL and Vectorize bindings usable for a new view', async () => {
    const sql = createSqliteDouble();
    const vectorize = createFakeVectorize();
    const storage = createCloudflareMemoryRecordStorage({ sql, vectorize });
    await storage.init();
    await storage.put(makeRecord('a'));

    await storage.close();

    // close() did not dispose the shared SQL binding: a fresh view over the same
    // bindings still reads the row. (init() is idempotent — CREATE IF NOT EXISTS.)
    const survivor = createCloudflareMemoryRecordStorage({ sql, vectorize });
    await survivor.init();
    expect(await survivor.get('a', SCOPE)).toBeDefined();
  });
});

describe('createSqliteDouble close()', () => {
  it('closes the underlying in-memory database', () => {
    const sql = createSqliteDouble();
    sql.exec(`CREATE TABLE t (x INTEGER)`);
    sql.close();

    // After close the database is released; using it throws.
    expect(() => sql.exec(`SELECT * FROM t`)).toThrow();
  });
});

describe('createCloudflareMemoryTestHarness', () => {
  let harness: ReturnType<typeof createCloudflareMemoryTestHarness>;

  beforeEach(async () => {
    harness = createCloudflareMemoryTestHarness();
    await harness.storage.init();
  });

  it('wires the backend to the exposed SQL and Vectorize doubles', async () => {
    await harness.storage.put(makeRecord('a'));

    // The exposed Vectorize double recorded the put's upsert.
    expect(harness.vectorize.upsertCalls).toHaveLength(1);
    // The exposed SQL double holds the canonical row.
    const rows = harness.sql
      .exec<{ id: string }>(`SELECT id FROM memory_records WHERE id = ?`, 'a')
      .toArray();
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('honors a custom tableName option', async () => {
    const custom = createCloudflareMemoryTestHarness({ tableName: 'custom_memories' });
    await custom.storage.init();
    await custom.storage.put(makeRecord('a'));

    const rows = custom.sql
      .exec<{ id: string }>(`SELECT id FROM custom_memories WHERE id = ?`, 'a')
      .toArray();
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('rejects a tableName that is not a safe SQL identifier', () => {
    // The table name is interpolated as a SQL identifier (params cannot bind
    // identifiers), so anything outside a strict identifier pattern — quotes,
    // semicolons, spaces, a leading digit — must be refused at construction, not
    // smuggled into a CREATE/SELECT.
    const sql = createSqliteDouble();
    const vectorize = createFakeVectorize();
    for (const bad of ['memory; DROP TABLE x', 'mem ory', 'memory"', '1memory', 'has-dash', '']) {
      expect(() => createCloudflareMemoryRecordStorage({ sql, vectorize, tableName: bad })).toThrow(
        /tableName must be a valid SQL identifier/,
      );
    }
  });
});

describe('Cloudflare memory dedupe keys', () => {
  it('returns an existing record for duplicate putOnce without a second Vectorize upsert', async () => {
    const vectorize = createFakeVectorize();
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize,
    });
    await storage.init();

    const first = await storage.putOnce!(makeRecord('first', { metadata: { dedupeKey: 'same' } }));
    const second = await storage.putOnce!(
      makeRecord('second', { content: 'different', metadata: { dedupeKey: 'same' } }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe('first');
    expect(second.record.content).toBe('content-first');
    expect(vectorize.upsertCalls).toHaveLength(1);
  });

  it('backfills dedupe_key from existing metadata before enforcing the unique index', async () => {
    const sql = createSqliteDouble();
    sql.exec(
      `CREATE TABLE memory_records (
         tenant_id  TEXT    NOT NULL,
         namespace  TEXT    NOT NULL,
         id         TEXT    NOT NULL,
         status     TEXT    NOT NULL,
         version    INTEGER NOT NULL,
         content    TEXT    NOT NULL,
         vector     TEXT    NOT NULL,
         metadata   TEXT    NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         indexed_at INTEGER NOT NULL,
         PRIMARY KEY (tenant_id, namespace, id)
       )`,
    );
    sql.exec(
      `INSERT INTO memory_records
         (tenant_id, namespace, id, status, version, content, vector, metadata, created_at, updated_at, indexed_at)
       VALUES (?, ?, ?, 'active', 1, ?, ?, ?, 1, 1, 1)`,
      TENANT,
      NAMESPACE,
      'old-row',
      'old content',
      JSON.stringify([1, 0]),
      JSON.stringify({ dedupeKey: 'old-key' }),
    );
    const vectorize = createFakeVectorize();
    const storage = createCloudflareMemoryRecordStorage({ sql, vectorize });

    await storage.init();
    const existing = await storage.getByDedupeKey!(SCOPE, 'old-key');
    const duplicate = await storage.putOnce!(
      makeRecord('new-row', { metadata: { dedupeKey: 'old-key' } }),
    );

    expect(existing?.id).toBe('old-row');
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe('old-row');
    expect(await storage.count(SCOPE)).toBe(1);
  });

  it('enforces one active row per dedupe key at the SQLite index', async () => {
    const sql = createSqliteDouble();
    const storage = createCloudflareMemoryRecordStorage({
      sql,
      vectorize: createFakeVectorize(),
    });
    await storage.init();
    await storage.put(makeRecord('first', { metadata: { dedupeKey: 'unique-key' } }));

    expect(() =>
      sql.exec(
        `INSERT INTO memory_records
           (tenant_id, namespace, id, status, version, content, vector, metadata, dedupe_key, created_at, updated_at, indexed_at)
         VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, 1, 1, 1)`,
        TENANT,
        NAMESPACE,
        'second',
        'second content',
        JSON.stringify([0, 1]),
        JSON.stringify({ dedupeKey: 'unique-key' }),
        'unique-key',
      ),
    ).toThrow();
  });

  it('repairs an unindexed dedupe winner on a later duplicate putOnce call', async () => {
    const sql = createSqliteDouble();
    const vectorize = createFakeVectorize();
    let failNextUpsert = true;
    const flakyVectorize = {
      ...vectorize,
      async upsert(vectors: Parameters<typeof vectorize.upsert>[0]) {
        if (failNextUpsert) {
          failNextUpsert = false;
          throw new Error('temporary vectorize failure');
        }
        return vectorize.upsert(vectors);
      },
    };
    const storage = createCloudflareMemoryRecordStorage({ sql, vectorize: flakyVectorize });
    await storage.init();

    await expect(
      storage.putOnce!(makeRecord('first', { metadata: { dedupeKey: 'repair-key' } })),
    ).rejects.toThrow(/temporary vectorize failure/);

    const duplicate = await storage.putOnce!(
      makeRecord('second', { metadata: { dedupeKey: 'repair-key' } }),
    );

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe('first');
    expect(vectorize.upsertCalls).toHaveLength(1);
    expect(vectorize.upsertCalls[0]![0]!.id).toContain(':first');
  });
});

describe('searchByVector limit edges', () => {
  let storage: ReturnType<typeof createCloudflareMemoryRecordStorage>;
  let vectorize: ReturnType<typeof createFakeVectorize>;

  beforeEach(async () => {
    vectorize = createFakeVectorize();
    storage = createCloudflareMemoryRecordStorage({ sql: createSqliteDouble(), vectorize });
    await storage.init();
  });

  it('returns [] for limit 0 without querying Vectorize', async () => {
    await storage.put(makeRecord('a'));
    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 0 });
    expect(hits).toEqual([]);
    // Short-circuit before touching the index — no wasted query.
    expect(vectorize.queryCalls).toHaveLength(0);
  });

  it('still returns a valid row at limit 1 when a poison hit sits in front', async () => {
    // Overfetch + post-filter must not let a single front poison hit starve the
    // result: with limit 1 and a leading poison id, the one real row must surface.
    await storage.put(makeRecord('real'));
    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:ghost`,
        score: 0.999,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'ghost', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 1 });
    expect(hits.map((h) => h.id)).toEqual(['real']);
  });

  it('rejects a limit above the documented maximum rather than silently truncating', async () => {
    // The overfetch is capped, so a limit beyond MAX_SEARCH_LIMIT could not be
    // honored without paging — reject it explicitly instead of returning fewer
    // than asked and pretending it was the whole result.
    await expect(
      storage.searchByVector([1, 0], SCOPE, { limit: MAX_SEARCH_LIMIT + 1 }),
    ).rejects.toThrow(/limit must be <=/);
  });
});
