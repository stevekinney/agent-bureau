import { describe, expect, it } from 'bun:test';
import type { MemoryRecord } from 'memory';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createCloudflareR2TextValueStore } from '../src/create-cloudflare-r2-text-value-store';
import { createCloudflareSqliteStorage } from '../src/create-cloudflare-sqlite-storage';
import { CloudflareBindingMismatchError, CloudflareSerializationError } from '../src/diagnostics';
import type { R2Bucket } from '../src/r2';
import type { Sql, SqlValue } from '../src/sql';
import { createFakeR2 } from '../src/test/fake-r2';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble } from '../src/test/sqlite-double';
import type { VectorizeIndex } from '../src/vectorize';

/**
 * TYPED DIAGNOSTICS (AB-277). Every binding mismatch, unsupported API, and
 * serialization failure the adapters can detect throws a typed diagnostic —
 * never a generic error, and never a silent fallback to a different backend.
 * Each negative case is paired with a positive control (a correct binding, a
 * supported API, a serializable value) proving the diagnostic does not fire
 * unconditionally.
 *
 * The unsupported-API scenario (calling `vectorize.query` on the real
 * Miniflare runtime, where it is remote-only) lives in
 * `src/test/runtime-only.test.ts` — it genuinely requires the real runtime
 * lane, which cannot be constructed here without pulling Miniflare into every
 * `bun test packages/cloudflare` invocation's fast path. Its positive control
 * is `test/cloudflare-backend-contract.test.ts`'s fast-double run, which
 * exercises the full Vectorize-backed contract.
 */

// A binding shaped as `unknown` at the call site: these tests deliberately
// hand the constructors a value that fails the production contract, so a cast
// through `unknown` is the honest way to construct "the wrong shape of thing"
// without widening the constructors' own parameter types.
function asSql(value: unknown): Sql {
  return value as Sql;
}
function asR2Bucket(value: unknown): R2Bucket {
  return value as R2Bucket;
}
function asVectorizeIndex(value: unknown): VectorizeIndex {
  return value as VectorizeIndex;
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? 'diagnostics-record',
    tenantId: 'diagnostics-tenant',
    namespace: 'diagnostics-namespace',
    content: overrides.content ?? 'diagnostics content',
    vector: overrides.vector ?? new Float32Array([1, 0, 0]),
    metadata: overrides.metadata ?? {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    version: overrides.version ?? 1,
    status: overrides.status ?? 'active',
  };
}

describe('binding-mismatch diagnostics', () => {
  it('createCloudflareSqliteStorage throws a typed diagnostic for a sql binding missing exec()', () => {
    expect(() => createCloudflareSqliteStorage({ sql: asSql({}) })).toThrow(
      CloudflareBindingMismatchError,
    );
    try {
      createCloudflareSqliteStorage({ sql: asSql({}) });
      throw new Error('expected createCloudflareSqliteStorage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareBindingMismatchError);
      expect((error as CloudflareBindingMismatchError).binding).toBe('sql');
      expect((error as CloudflareBindingMismatchError).missingMember).toBe('exec');
    }
  });

  it('POSITIVE CONTROL: createCloudflareSqliteStorage accepts a correctly-shaped sql binding', async () => {
    const storage = createCloudflareSqliteStorage({ sql: createSqliteDouble() });
    await storage.put('probe', new Uint8Array([1]));
    expect(await storage.get('probe')).toEqual(new Uint8Array([1]));
  });

  it('createCloudflareR2TextValueStore throws a typed diagnostic for a bucket binding missing list()', () => {
    const almostBucket = {
      head: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
      // `list` deliberately omitted.
    };

    try {
      createCloudflareR2TextValueStore({ bucket: asR2Bucket(almostBucket) });
      throw new Error('expected createCloudflareR2TextValueStore to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareBindingMismatchError);
      expect((error as CloudflareBindingMismatchError).binding).toBe('r2Bucket');
      expect((error as CloudflareBindingMismatchError).missingMember).toBe('list');
    }
  });

  it('POSITIVE CONTROL: createCloudflareR2TextValueStore accepts a correctly-shaped bucket binding', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    await store.set('probe', 'value');
    expect(await store.get('probe')).toBe('value');
  });

  it('createCloudflareMemoryRecordStorage throws for a mismatched sql binding and never touches vectorize', () => {
    const vectorize = createFakeVectorize();

    try {
      createCloudflareMemoryRecordStorage({ sql: asSql(null), vectorize });
      throw new Error('expected createCloudflareMemoryRecordStorage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareBindingMismatchError);
      expect((error as CloudflareBindingMismatchError).binding).toBe('sql');
      expect((error as CloudflareBindingMismatchError).missingMember).toBe('exec');
    }

    // NO FALLBACK: construction never reached vectorize.
    expect(vectorize.upsertCalls).toEqual([]);
    expect(vectorize.queryCalls).toEqual([]);
    expect(vectorize.deleteCalls).toEqual([]);
  });

  it('createCloudflareMemoryRecordStorage throws for a mismatched vectorize binding and never touches sql', () => {
    const underlying = createSqliteDouble();
    let execCallCount = 0;
    const countingSql: Sql = {
      exec<Row extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
        execCallCount += 1;
        return underlying.exec<Row>(query, ...bindings);
      },
    };

    try {
      createCloudflareMemoryRecordStorage({
        sql: countingSql,
        vectorize: asVectorizeIndex({ upsert: () => Promise.resolve() }),
      });
      throw new Error('expected createCloudflareMemoryRecordStorage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareBindingMismatchError);
      expect((error as CloudflareBindingMismatchError).binding).toBe('vectorize');
      expect((error as CloudflareBindingMismatchError).missingMember).toBe('query');
    }

    // NO FALLBACK: construction never reached sql.
    expect(execCallCount).toBe(0);
  });

  it('POSITIVE CONTROL: createCloudflareMemoryRecordStorage accepts correctly-shaped sql and vectorize bindings', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();
    await storage.put(memoryRecord());
    const fetched = await storage.get('diagnostics-record', {
      tenantId: 'diagnostics-tenant',
      namespace: 'diagnostics-namespace',
    });
    expect(fetched?.content).toBe('diagnostics content');
  });
});

describe('serialization-failure diagnostics', () => {
  it('rejects a non-finite vector component before any write, naming the field', async () => {
    const sql = createSqliteDouble();
    let execCallCount = 0;
    const countingSql: Sql = {
      exec<Row extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
        execCallCount += 1;
        return sql.exec<Row>(query, ...bindings);
      },
    };
    const storage = createCloudflareMemoryRecordStorage({
      sql: countingSql,
      vectorize: createFakeVectorize(),
    });
    await storage.init();
    execCallCount = 0; // Only count what `put` itself does below.

    await expect(
      storage.put(memoryRecord({ vector: new Float32Array([1, Number.NaN, 0]) })),
    ).rejects.toThrow(CloudflareSerializationError);

    try {
      await storage.put(memoryRecord({ vector: new Float32Array([1, Number.NaN, 0]) }));
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('vector[1]');
    }

    // NO PARTIAL WRITE: the rejected put() never reached sql.exec.
    expect(execCallCount).toBe(0);
  });

  it('rejects metadata that cannot round-trip through JSON, naming the field path', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    try {
      await storage.put(
        memoryRecord({ id: 'undefined-metadata', metadata: { note: undefined as unknown } }),
      );
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('metadata.note');
    }
  });

  it('rejects a non-plain object nested in metadata (a Date) instead of silently stringifying it', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    try {
      await storage.put(memoryRecord({ id: 'date-metadata', metadata: { created: new Date(0) } }));
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('metadata.created');
    }
  });

  it('rejects a non-plain object nested in metadata (a Map) instead of silently erasing it', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    try {
      await storage.put(
        memoryRecord({ id: 'map-metadata', metadata: { lookup: new Map([['a', 1]]) } }),
      );
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('metadata.lookup');
    }
  });

  it('POSITIVE CONTROL: a plain object created with Object.create(null) is accepted as metadata', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    const nullProtoNested: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    nullProtoNested['value'] = 'plain';

    await storage.put(
      memoryRecord({ id: 'null-proto-metadata', metadata: { nested: nullProtoNested } }),
    );
    const fetched = await storage.get('null-proto-metadata', {
      tenantId: 'diagnostics-tenant',
      namespace: 'diagnostics-namespace',
    });
    expect(fetched?.metadata).toEqual({ nested: { value: 'plain' } });
  });

  it('rejects a non-finite number nested inside metadata, naming the nested field path', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    try {
      await storage.put(
        memoryRecord({
          id: 'nested-non-finite',
          metadata: { nested: { score: Number.NaN } },
        }),
      );
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('metadata.nested.score');
    }
  });

  it('rejects metadata containing a circular array reference instead of overflowing the call stack', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    try {
      await storage.put(memoryRecord({ id: 'cyclic-array', metadata: { list: cyclicArray } }));
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      // The array itself is added to `seen` before its own elements are
      // walked, so the cycle is detected one level deeper, at the
      // self-referencing element (index 0), not at `metadata.list` itself.
      expect((error as CloudflareSerializationError).field).toBe('metadata.list.0');
    }
  });

  it('rejects metadata containing a circular object reference instead of overflowing the call stack', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    try {
      await storage.put(memoryRecord({ id: 'cyclic-object', metadata: cyclic }));
      throw new Error('expected put() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareSerializationError);
      expect((error as CloudflareSerializationError).field).toBe('metadata.self');
    }
  });

  it('rejects a non-finite vector on putOnce and on update, naming the field, before any write', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    await expect(
      storage.putOnce!(
        memoryRecord({
          id: 'putonce-record',
          vector: new Float32Array([Number.POSITIVE_INFINITY]),
          metadata: { dedupeKey: 'putonce-key' },
        }),
      ),
    ).rejects.toThrow(CloudflareSerializationError);

    await storage.put(memoryRecord({ id: 'update-target' }));
    await expect(
      storage.update(
        'update-target',
        {
          tenantId: 'diagnostics-tenant',
          namespace: 'diagnostics-namespace',
        },
        { vector: new Float32Array([Number.NaN]) },
      ),
    ).rejects.toThrow(CloudflareSerializationError);

    // The update rejection must not have applied: the original record is unchanged.
    const stillOriginal = await storage.get('update-target', {
      tenantId: 'diagnostics-tenant',
      namespace: 'diagnostics-namespace',
    });
    expect(stillOriginal?.version).toBe(1);
  });

  it('POSITIVE CONTROL: a serializable vector and metadata write and read back unchanged', async () => {
    const storage = createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    });
    await storage.init();

    const record = memoryRecord({
      id: 'serializable-record',
      vector: new Float32Array([0.5, -0.25, 0]),
      metadata: { nested: { list: [1, 2, 3] }, flag: true, label: 'ok' },
    });
    await storage.put(record);

    const fetched = await storage.get('serializable-record', {
      tenantId: 'diagnostics-tenant',
      namespace: 'diagnostics-namespace',
    });
    expect(fetched?.metadata).toEqual({ nested: { list: [1, 2, 3] }, flag: true, label: 'ok' });
  });
});
