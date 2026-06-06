import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
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

function makeRecord(id: string): MemoryRecord {
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
});
