import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';
import type { MemoryRecord, MemoryRecordScope } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble } from '../src/test/sqlite-double';

const TENANT = 'tenant-a';
const NAMESPACE = 'alpha';
const SCOPE: MemoryRecordScope = { tenantId: TENANT, namespace: NAMESPACE };

function makeRecord(id: string): MemoryRecord {
  return {
    id,
    tenantId: TENANT,
    namespace: NAMESPACE,
    content: `content-${id}`,
    vector: new Float32Array([1, 0]),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    status: 'active',
  };
}

/**
 * AB-327: `createCloudflareMemoryRecordStorage`'s eight internal wall-clock
 * reads (indexed_at/updated_at writes on index/update/delete/deleteNamespace)
 * previously called `Date.now()` directly. This proves the injected
 * `RuntimeServices` clock is what the store actually reads, not the real
 * wall clock — a real Date.now() call here would never equal the pinned
 * manual-runtime value below.
 */
describe('createCloudflareMemoryRecordStorage runtime injection', () => {
  it("delete()'s tombstone updated_at follows the injected RuntimeServices clock, not the real wall clock", async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const sql = createSqliteDouble();
    const store = createCloudflareMemoryRecordStorage({
      sql,
      vectorize: createFakeVectorize(),
      runtime,
    });
    await store.init();
    await store.put(makeRecord('record-1'));

    await runtime.advance(60_000);
    const deleted = await store.delete('record-1', SCOPE);
    expect(deleted).toBe(true);

    const rows = sql
      .exec<{ updated_at: number }>(
        `SELECT updated_at FROM memory_records WHERE tenant_id = ? AND namespace = ? AND id = ?`,
        TENANT,
        NAMESPACE,
        'record-1',
      )
      .toArray();
    expect(rows[0]?.updated_at).toBe(Date.parse('2030-01-01T00:01:00.000Z'));
  });

  it('defaults to the real-globals RuntimeServices implementation when no runtime is injected', async () => {
    const sql = createSqliteDouble();
    const store = createCloudflareMemoryRecordStorage({
      sql,
      vectorize: createFakeVectorize(),
    });
    await store.init();
    const before = Date.now();
    await store.put(makeRecord('record-1'));
    const deleted = await store.delete('record-1', SCOPE);
    const after = Date.now();
    expect(deleted).toBe(true);

    // Review finding (Copilot, PR #549): `after >= before` alone passes even
    // if delete() never wrote a timestamp at all. Query the tombstoned row
    // directly and assert its updated_at genuinely falls inside the real
    // [before, after] window — proving the default resolves to a working
    // real clock, not merely that the two Date.now() calls above ordered
    // correctly.
    const rows = sql
      .exec<{ updated_at: number }>(
        `SELECT updated_at FROM memory_records WHERE tenant_id = ? AND namespace = ? AND id = ?`,
        TENANT,
        NAMESPACE,
        'record-1',
      )
      .toArray();
    expect(rows[0]?.updated_at).toBeGreaterThanOrEqual(before);
    expect(rows[0]?.updated_at).toBeLessThanOrEqual(after);
  });
});
