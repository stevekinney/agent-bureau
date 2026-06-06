import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble, type SqliteDouble } from '../src/test/sqlite-double';

/**
 * Cloudflare-backend-SPECIFIC boundary behavior NOT covered by the shared
 * contract suite:
 * - SQLite-stored `vector`/`metadata` JSON is untrusted at the read boundary and
 *   fails loudly through Zod when corrupt (mirrors the Weft backend's
 *   durable-bytes decode test);
 * - a missing-or-empty `tenantId` (this backend requires one) and an empty
 *   `namespace` throw at the storage boundary.
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

describe('decode validation (SQLite-stored JSON is untrusted)', () => {
  let sql: SqliteDouble;
  let storage: MemoryRecordStorage;

  /** Overwrite the canonical JSON columns of a row with raw corrupt strings. */
  function corruptRow(id: string, columns: { vector?: string; metadata?: string }): void {
    if (columns.vector !== undefined) {
      sql.exec(
        `UPDATE memory_records SET vector = ? WHERE tenant_id = ? AND namespace = ? AND id = ?`,
        columns.vector,
        TENANT,
        NAMESPACE,
        id,
      );
    }
    if (columns.metadata !== undefined) {
      sql.exec(
        `UPDATE memory_records SET metadata = ? WHERE tenant_id = ? AND namespace = ? AND id = ?`,
        columns.metadata,
        TENANT,
        NAMESPACE,
        id,
      );
    }
  }

  beforeEach(async () => {
    sql = createSqliteDouble();
    storage = createCloudflareMemoryRecordStorage({ sql, vectorize: createFakeVectorize() });
    await storage.init();
  });

  it('throws when the stored vector JSON is not valid JSON', async () => {
    await storage.put(makeRecord('a'));
    corruptRow('a', { vector: '{ not json' });
    await expect(storage.get('a', SCOPE)).rejects.toThrow();
  });

  it('throws when a stored vector entry is non-finite', async () => {
    await storage.put(makeRecord('a'));
    // JSON has no Infinity literal; a corrupt finite-violating value arrives as
    // null, which the finite-number schema must reject.
    corruptRow('a', { vector: '[1, null, 3]' });
    await expect(storage.get('a', SCOPE)).rejects.toThrow();
  });

  it('throws when the stored metadata JSON is not an object', async () => {
    await storage.put(makeRecord('a'));
    corruptRow('a', { metadata: '"a bare string, not a record"' });
    await expect(storage.get('a', SCOPE)).rejects.toThrow();
  });

  it('surfaces corruption through list() too, not just get()', async () => {
    await storage.put(makeRecord('a'));
    corruptRow('a', { vector: 'not-json-at-all' });
    await expect(storage.list(SCOPE)).rejects.toThrow();
  });
});

describe('tenantId / namespace required at the storage boundary', () => {
  let storage: MemoryRecordStorage;

  beforeEach(async () => {
    storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();
  });

  it('rejects a missing tenantId on a scoped read', async () => {
    await expect(storage.get('a', { namespace: NAMESPACE })).rejects.toThrow(
      /tenantId must be a non-empty string/,
    );
    await expect(storage.count({ namespace: NAMESPACE })).rejects.toThrow(
      /tenantId must be a non-empty string/,
    );
  });

  it('rejects an empty tenantId on a scoped read', async () => {
    await expect(storage.get('a', { tenantId: '', namespace: NAMESPACE })).rejects.toThrow(
      /tenantId must be a non-empty string/,
    );
  });

  it('rejects an empty namespace on a scoped read', async () => {
    await expect(storage.get('a', { tenantId: TENANT, namespace: '' })).rejects.toThrow(
      /namespace must be a non-empty string/,
    );
    await expect(storage.count({ tenantId: TENANT, namespace: '' })).rejects.toThrow(
      /namespace must be a non-empty string/,
    );
  });

  it('rejects a put() whose record has no tenantId', async () => {
    const record = makeRecord('a');
    const { tenantId: _omit, ...withoutTenant } = record;
    await expect(storage.put(withoutTenant as MemoryRecord)).rejects.toThrow(
      /tenantId must be a non-empty string/,
    );
  });

  it('rejects searchByVector and deleteNamespace without a tenantId', async () => {
    await expect(
      storage.searchByVector([1, 0], { namespace: NAMESPACE }, { limit: 5 }),
    ).rejects.toThrow(/tenantId must be a non-empty string/);
    await expect(storage.deleteNamespace({ namespace: NAMESPACE })).rejects.toThrow(
      /tenantId must be a non-empty string/,
    );
  });
});
