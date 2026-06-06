import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createFakeVectorize, type FakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble, type SqliteDouble } from '../src/test/sqlite-double';

/**
 * SECURITY / REHYDRATION — the crux of the two-store join.
 *
 * Vectorize is a SECONDARY index that can lag or diverge from the canonical
 * SQLite store. The backend must NEVER trust a Vectorize match as the security
 * boundary: every returned id is rehydrated and re-scoped against active SQLite
 * rows (tenant + namespace + version). These tests drive the ADVERSARIAL fake to
 * inject each poison class and prove searchByVector surfaces NONE of them — only
 * correctly-scoped, current, active rows.
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

describe('searchByVector rehydration security', () => {
  let sql: SqliteDouble;
  let vectorize: FakeVectorize;
  let storage: MemoryRecordStorage;

  beforeEach(async () => {
    sql = createSqliteDouble();
    vectorize = createFakeVectorize();
    storage = createCloudflareMemoryRecordStorage({ sql, vectorize });
    await storage.init();
    // One legitimate, correctly-scoped active row that every search should find.
    await storage.put(makeRecord('legit', { vector: new Float32Array([1, 0]) }));
  });

  it('carries a server-owned tenant + namespace filter and requests metadata', async () => {
    await storage.searchByVector([1, 0], SCOPE, { limit: 10 });

    expect(vectorize.queryCalls).toHaveLength(1);
    const call = vectorize.queryCalls[0]!;
    expect(call.options.filter).toEqual({ tenant_id: TENANT, namespace: NAMESPACE });
    expect(call.options.returnMetadata).toBe(true);
    expect(call.options.topK).toBe(10);
  });

  it('drops a cross-tenant hit', async () => {
    // The poison id genuinely EXISTS — but under tenant-b. The drop must come
    // from the rehydration `tenant_id = 'tenant-a'` filter NOT finding the
    // tenant-b row, not from the id being absent everywhere. (Strip the
    // tenant_id clause from activeRow and this test goes red.)
    await storage.put({
      ...makeRecord('shared-id', { vector: new Float32Array([1, 0]) }),
      tenantId: 'tenant-b',
    });

    vectorize.injectPoison([
      {
        id: 'shared-id',
        score: 0.99,
        metadata: { tenant_id: 'tenant-b', namespace: NAMESPACE, version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a wrong-namespace hit', async () => {
    // The poison id genuinely EXISTS — but under namespace 'beta'. The drop must
    // come from the rehydration `namespace = 'alpha'` filter NOT finding the beta
    // row, not from the id being absent. (Strip the namespace clause from
    // activeRow and this test goes red.)
    await storage.put(
      makeRecord('beta-row', { namespace: 'beta', vector: new Float32Array([1, 0]) }),
    );

    vectorize.injectPoison([
      {
        id: 'beta-row',
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: 'beta', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a stale-version hit even when the id is correctly scoped', async () => {
    // 'legit' is at version 1; the adversary advertises a different version for
    // the same id. The canonical row exists and is in-scope, so ONLY the version
    // gate can drop it — proving the version compare is real.
    vectorize.injectPoison([
      {
        id: 'legit',
        score: 0.5,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 99 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    // The genuine match for 'legit' (version 1) still surfaces; the stale poison
    // copy does not produce a second, lower-scored 'legit'.
    expect(hits.map((h) => h.id)).toEqual(['legit']);
    expect(hits[0]!.record.version).toBe(1);
  });

  it('drops a hit whose advertised version is missing entirely', async () => {
    vectorize.injectPoison([
      { id: 'legit', score: 0.5, metadata: { tenant_id: TENANT, namespace: NAMESPACE } },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a deleted (tombstoned) hit', async () => {
    await storage.put(makeRecord('doomed', { vector: new Float32Array([1, 0]) }));
    await storage.delete('doomed', SCOPE);

    // The secondary index still "remembers" the doomed id and returns it.
    vectorize.injectPoison([
      {
        id: 'doomed',
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a hit absent from SQLite entirely', async () => {
    vectorize.injectPoison([
      {
        id: 'never-stored',
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops every poison class at once, surfacing only the legit row', async () => {
    await storage.put(makeRecord('doomed', { vector: new Float32Array([1, 0]) }));
    await storage.delete('doomed', SCOPE);

    vectorize.injectPoison([
      {
        id: 'cross-tenant',
        score: 0.99,
        metadata: { tenant_id: 'tenant-b', namespace: NAMESPACE, version: 1 },
      },
      {
        id: 'wrong-namespace',
        score: 0.98,
        metadata: { tenant_id: TENANT, namespace: 'beta', version: 1 },
      },
      {
        id: 'legit',
        score: 0.97,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 99 },
      },
      {
        id: 'doomed',
        score: 0.96,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 1 },
      },
      {
        id: 'never-stored',
        score: 0.95,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 20 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
    expect(hits[0]!.record.version).toBe(1);
    expect(hits[0]!.record.content).toBe('content-legit');
  });

  describe('Vectorize upsert metadata is server-owned and allowlisted', () => {
    it('writes only { tenant_id, namespace, memory_id, created_at, version } — never content or caller metadata', async () => {
      vectorize = createFakeVectorize();
      sql = createSqliteDouble();
      storage = createCloudflareMemoryRecordStorage({ sql, vectorize });
      await storage.init();

      await storage.put(
        makeRecord('secret', {
          content: 'TOP SECRET content that must not reach the index',
          metadata: { ssn: '123-45-6789', injected: 'evil' },
          createdAt: 4242,
          version: 1,
        }),
      );

      expect(vectorize.upsertCalls).toHaveLength(1);
      const [vector] = vectorize.upsertCalls[0]!;
      expect(vector!.metadata).toEqual({
        tenant_id: TENANT,
        namespace: NAMESPACE,
        memory_id: 'secret',
        created_at: 4242,
        version: 1,
      });
      // No content, no caller metadata keys leak into the secondary index.
      expect(Object.keys(vector!.metadata)).not.toContain('content');
      expect(Object.keys(vector!.metadata)).not.toContain('ssn');
      expect(Object.keys(vector!.metadata)).not.toContain('injected');
    });

    it('re-upserts with the bumped version after update so the index version tracks canonical', async () => {
      await storage.update('legit', SCOPE, { content: 'patched' });

      const lastUpsert = vectorize.upsertCalls.at(-1)!;
      expect(lastUpsert[0]!.metadata['version']).toBe(2);
    });
  });
});
