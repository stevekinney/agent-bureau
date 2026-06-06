import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import type { Sql, SqlCursor, SqlValue } from '../src/sql';
import { createFakeVectorize, type FakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble, type SqliteDouble } from '../src/test/sqlite-double';

/**
 * TOMBSTONE ORDERING — delete must write the SQLite tombstone BEFORE removing the
 * id from Vectorize. The ordering is load-bearing: the instant the canonical row
 * stops being active, a stale Vectorize hit for that id is dropped on
 * rehydration, so there is no window where a deleted record could resurface.
 *
 * To prove cross-store ordering, the SQL double is wrapped so a status=>'deleted'
 * UPDATE pushes `sql:tombstone` onto a shared event log that the Vectorize fake's
 * `delete` also lands on (as `vectorize:delete`).
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

/**
 * Wrap a {@link Sql} double so any `status = 'deleted'` UPDATE appends
 * `sql:tombstone` to a shared ordering log before delegating to the real exec.
 */
function instrumentSql(inner: SqliteDouble, log: string[]): Sql {
  return {
    exec<Row extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<Row> {
      if (/status\s*=\s*'deleted'/i.test(query)) log.push('sql:tombstone');
      return inner.exec<Row>(query, ...bindings);
    },
  };
}

describe('delete tombstone ordering', () => {
  let inner: SqliteDouble;
  let vectorize: FakeVectorize;
  let log: string[];
  let storage: MemoryRecordStorage;

  beforeEach(async () => {
    inner = createSqliteDouble();
    vectorize = createFakeVectorize();
    log = [];
    const sql = instrumentSql(inner, log);
    // Mirror the fake's delete onto the same ordering log.
    const recordingVectorize: FakeVectorize = {
      ...vectorize,
      deleteByIds(ids: string[]): Promise<void> {
        log.push('vectorize:delete');
        return vectorize.deleteByIds(ids);
      },
    };
    storage = createCloudflareMemoryRecordStorage({ sql, vectorize: recordingVectorize });
    await storage.init();
  });

  it('writes the SQLite tombstone before the Vectorize delete on delete()', async () => {
    await storage.put(makeRecord('a'));
    log.length = 0; // ignore put-time index calls

    expect(await storage.delete('a', SCOPE)).toBe(true);
    expect(log).toEqual(['sql:tombstone', 'vectorize:delete']);
  });

  it('writes the SQLite tombstone before the Vectorize delete on deleteNamespace()', async () => {
    await storage.put(makeRecord('a'));
    await storage.put(makeRecord('b'));
    log.length = 0;

    expect(await storage.deleteNamespace(SCOPE)).toBe(2);
    expect(log).toEqual(['sql:tombstone', 'vectorize:delete']);
  });

  it('a stale Vectorize hit for a tombstoned id is dropped on rehydration', async () => {
    await storage.put(makeRecord('a', { vector: new Float32Array([1, 0]) }));
    await storage.put(makeRecord('b', { vector: new Float32Array([1, 0]) }));
    await storage.delete('a', SCOPE);

    // The secondary index lags and still returns the tombstoned id 'a'.
    vectorize.injectPoison([
      { id: 'a', score: 0.99, metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 1 } },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['b']);
  });
});
