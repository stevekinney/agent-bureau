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
    // The backend OVERFETCHES (topK > limit) so rehydration can drop poison/stale
    // hits and still return up to `limit` valid rows; it must not pass topK = limit.
    expect(call.options.topK).toBeGreaterThan(10);
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
        id: 'tenant-b:alpha:shared-id',
        score: 0.99,
        // memory_id is present and well-formed; the drop must come from the
        // rehydration tenant scope-check (SCOPE is tenant-a) NOT finding a
        // tenant-a row for this id, not from the metadata being unreadable.
        metadata: {
          tenant_id: 'tenant-b',
          namespace: NAMESPACE,
          memory_id: 'shared-id',
          version: 1,
        },
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
        id: `${TENANT}:beta:beta-row`,
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: 'beta', memory_id: 'beta-row', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a stale-version (ahead-of-canonical) hit even when the id is correctly scoped', async () => {
    // 'legit' is at version 1; the adversary advertises version 99 — AHEAD of the
    // canonical row. Because every write hits SQLite before Vectorize, the index
    // can never legitimately be ahead, so an ahead-version hit is poison. The
    // canonical row exists and is in-scope, so ONLY the version gate can drop it —
    // proving the version compare is real.
    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:legit`,
        score: 0.5,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 99 },
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
      {
        id: `${TENANT}:${NAMESPACE}:legit`,
        score: 0.5,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit' },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('KEEPS a hit whose advertised version is behind canonical (benign index lag)', async () => {
    // Bump 'legit' to version 3 in canonical SQLite; the index still advertises
    // the older version 1 for the same id. Because the index can only ever lag
    // (SQLite is written first), a behind-version hit is a valid pointer to a live
    // row, NOT poison — it must surface, rehydrated to the canonical record. This
    // is the case the old strict !== gate wrongly dropped, making a live record
    // vanish from search on a benign lag.
    await storage.update('legit', SCOPE, { content: 'v2' });
    await storage.update('legit', SCOPE, { content: 'v3' });

    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:legit`,
        score: 0.9,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
    // Surfaced record is the CANONICAL current version, never the stale copy.
    expect(hits[0]!.record.version).toBe(3);
    expect(hits[0]!.record.content).toBe('v3');
  });

  it('drops a deleted (tombstoned) hit', async () => {
    await storage.put(makeRecord('doomed', { vector: new Float32Array([1, 0]) }));
    await storage.delete('doomed', SCOPE);

    // The secondary index still "remembers" the doomed id and returns it.
    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:doomed`,
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'doomed', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops a hit whose Vectorize id is not a well-formed scoped id', async () => {
    // A malformed vector id (wrong part count, or undecodable percent-escape)
    // cannot be trusted for identity, so it is dropped before rehydration. Only
    // the genuine 'legit' remains.
    vectorize.injectPoison([
      // Not three colon-separated parts.
      {
        id: 'not-a-scoped-id',
        score: 0.99,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 1 },
      },
      // Three parts, but the id component is an invalid percent-escape that
      // decodeURIComponent rejects.
      {
        id: `${TENANT}:${NAMESPACE}:%E0%A4%A`,
        score: 0.98,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops an identity-spoof hit whose scoped id and metadata memory_id disagree', async () => {
    // Adversary crafts a hit whose metadata claims memory_id 'legit' (a real,
    // in-scope, current row) but whose scope-encoded vector id points at a
    // different memory id. Identity must come from the trustworthy scoped id, not
    // the metadata, so this hit is dropped — it cannot borrow 'legit''s identity
    // (and surface it with the spoof's score). Only the genuine 'legit' remains.
    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:not-legit`,
        score: 0.999,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
    // The surfaced 'legit' is the genuine hit (score 1.0 against [1,0]), not the
    // 0.999 spoof — the spoof never claimed the slot.
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('prefers the current-version hit over a higher-scored stale one for the same record', async () => {
    // 'item' is bumped to version 2 in canonical SQLite. Its stored vector is
    // ORTHOGONAL to the query, so the fake's genuine candidate for it scores 0 and
    // does not dominate — isolating the dedupe decision to the two injected hits:
    // a stale version-1 entry (high score) and the current version-2 entry (lower
    // score). Dedupe must surface the CURRENT one, not let the higher-scored stale
    // vector win the slot.
    await storage.put(makeRecord('item', { vector: new Float32Array([0, 1]) }));
    await storage.update('item', SCOPE, { content: 'v2' });

    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:item`,
        score: 0.4, // current version, lower score
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'item', version: 2 },
      },
      {
        id: `${TENANT}:${NAMESPACE}:item`,
        score: 0.99, // stale version, higher score
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'item', version: 1 },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    const itemHits = hits.filter((h) => h.id === 'item');
    expect(itemHits).toHaveLength(1);
    // The current-version hit won the slot despite its lower score.
    expect(itemHits[0]!.score).toBeCloseTo(0.4, 5);
    expect(itemHits[0]!.record.version).toBe(2);
  });

  it('drops a hit absent from SQLite entirely', async () => {
    vectorize.injectPoison([
      {
        id: `${TENANT}:${NAMESPACE}:never-stored`,
        score: 0.99,
        // Well-formed in-scope metadata; the drop is the SQLite rehydration
        // finding no canonical row for this id.
        metadata: {
          tenant_id: TENANT,
          namespace: NAMESPACE,
          memory_id: 'never-stored',
          version: 1,
        },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
  });

  it('drops every poison class at once, surfacing only the legit row', async () => {
    await storage.put(makeRecord('doomed', { vector: new Float32Array([1, 0]) }));
    await storage.delete('doomed', SCOPE);

    // Every poison hit carries well-formed, in-band metadata (id, memory_id) so
    // each is dropped by its intended rehydration check — scope, version (ahead),
    // tombstone, or SQLite-absence — never by unreadable metadata.
    vectorize.injectPoison([
      {
        id: 'tenant-b:alpha:cross-tenant',
        score: 0.99,
        metadata: {
          tenant_id: 'tenant-b',
          namespace: NAMESPACE,
          memory_id: 'cross-tenant',
          version: 1,
        },
      },
      {
        id: `${TENANT}:beta:wrong-namespace`,
        score: 0.98,
        metadata: {
          tenant_id: TENANT,
          namespace: 'beta',
          memory_id: 'wrong-namespace',
          version: 1,
        },
      },
      {
        id: `${TENANT}:${NAMESPACE}:legit`,
        score: 0.97,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'legit', version: 99 },
      },
      {
        id: `${TENANT}:${NAMESPACE}:doomed`,
        score: 0.96,
        metadata: { tenant_id: TENANT, namespace: NAMESPACE, memory_id: 'doomed', version: 1 },
      },
      {
        id: `${TENANT}:${NAMESPACE}:never-stored`,
        score: 0.95,
        metadata: {
          tenant_id: TENANT,
          namespace: NAMESPACE,
          memory_id: 'never-stored',
          version: 1,
        },
      },
    ]);

    const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 20 });
    expect(hits.map((h) => h.id)).toEqual(['legit']);
    expect(hits[0]!.record.version).toBe(1);
    expect(hits[0]!.record.content).toBe('content-legit');
  });

  describe('scoped Vectorize id: the same memory id in two scopes does not collide', () => {
    it('keeps two tenants’ same-id vectors independent through search and delete', async () => {
      // Same memory id 'doc' under tenant-a and tenant-b. If the Vectorize id were
      // the bare memory id, the second put would overwrite the first's vector and
      // deleting one would delete the other's index entry.
      const scopeA: MemoryRecordScope = { tenantId: 'tenant-a', namespace: NAMESPACE };
      const scopeB: MemoryRecordScope = { tenantId: 'tenant-b', namespace: NAMESPACE };
      await storage.put({
        ...makeRecord('doc', { content: 'A-doc', vector: new Float32Array([1, 0]) }),
        tenantId: 'tenant-a',
      });
      await storage.put({
        ...makeRecord('doc', { content: 'B-doc', vector: new Float32Array([1, 0]) }),
        tenantId: 'tenant-b',
      });

      // Each tenant's search finds its OWN 'doc' (plus tenant-a also has 'legit').
      const aHits = await storage.searchByVector([1, 0], scopeA, { limit: 10 });
      expect(aHits.map((h) => h.id).sort()).toEqual(['doc', 'legit']);
      expect(aHits.find((h) => h.id === 'doc')!.record.content).toBe('A-doc');

      const bHits = await storage.searchByVector([1, 0], scopeB, { limit: 10 });
      expect(bHits.map((h) => h.id)).toEqual(['doc']);
      expect(bHits[0]!.record.content).toBe('B-doc');

      // Deleting tenant-a's 'doc' must leave tenant-b's 'doc' fully searchable and
      // gettable — the scoped Vectorize id keeps the two index entries distinct.
      expect(await storage.delete('doc', scopeA)).toBe(true);
      expect(await storage.get('doc', scopeA)).toBeUndefined();
      expect(await storage.get('doc', scopeB)).toBeDefined();
      const bAfter = await storage.searchByVector([1, 0], scopeB, { limit: 10 });
      expect(bAfter.map((h) => h.id)).toEqual(['doc']);
      expect(bAfter[0]!.record.content).toBe('B-doc');
    });
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
