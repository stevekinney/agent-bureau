import type { EmbeddingVectorLike } from 'interoperability';
import type {
  MemoryRecord,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
} from 'memory';
import { z } from 'zod';

import type { Sql, SqlValue } from './sql';
import type { VectorizeIndex, VectorizeMetadataValue } from './vectorize';

/**
 * Options for {@link createCloudflareMemoryRecordStorage}.
 */
export interface CreateCloudflareMemoryRecordStorageOptions {
  /**
   * The injectable SQL surface. In production this is the Durable Object
   * `ctx.storage.sql` binding (canonical store); in tests it is a bun:sqlite
   * double.
   */
  sql: Sql;
  /**
   * The injectable Vectorize surface. In production this is a Vectorize binding
   * (secondary index); in tests it is a recording, adversarial fake.
   */
  vectorize: VectorizeIndex;
  /**
   * The SQLite table name for memory records. Defaults to `memory_records`.
   * Provided so multiple logical stores can share one Durable Object without
   * colliding.
   */
  tableName?: string;
}

/** Default table name for the canonical SQLite store. */
export const DEFAULT_MEMORY_TABLE_NAME = 'memory_records';

/**
 * Row schema for a canonical SQLite memory record. The dense `vector` and free
 * `metadata` are persisted as JSON strings (SQLite has no array/object column),
 * so they are decoded through this schema at the read boundary — exactly like
 * the Weft backend treats its durable bytes. A corrupt or partially-written row
 * fails loudly here instead of surfacing a garbage record.
 */
const storedRowSchema = z.object({
  tenant_id: z.string(),
  namespace: z.string(),
  id: z.string(),
  status: z.union([z.literal('active'), z.literal('deleted')]),
  version: z.number().finite(),
  content: z.string(),
  vector: z.string(),
  metadata: z.string(),
  created_at: z.number().finite(),
  updated_at: z.number().finite(),
});

/** Schema for the decoded JSON `vector` column: a finite number array. */
const vectorJsonSchema = z.array(z.number().finite());

/** Schema for the decoded JSON `metadata` column: an arbitrary string-keyed map. */
const metadataJsonSchema = z.record(z.string(), z.unknown());

/**
 * Reconstitute a {@link MemoryRecord} from a canonical SQLite row, decoding the
 * JSON `vector`/`metadata` columns through Zod. The row's `tenant_id` is folded
 * back onto the record only when non-empty so a tenant-free record round-trips
 * with `tenantId` absent rather than `''`.
 */
function rowToRecord(row: z.infer<typeof storedRowSchema>): MemoryRecord {
  const vector = vectorJsonSchema.parse(JSON.parse(row.vector));
  const metadata = metadataJsonSchema.parse(JSON.parse(row.metadata));
  return {
    id: row.id,
    ...(row.tenant_id.length > 0 ? { tenantId: row.tenant_id } : {}),
    namespace: row.namespace,
    content: row.content,
    vector: new Float32Array(vector),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    status: row.status,
  };
}

/**
 * Run a synchronous body and surface its result (or a thrown error) as a
 * Promise. The Cloudflare reads are synchronous against SQLite, but the
 * {@link MemoryRecordStorage} contract returns Promises and callers rely on
 * `.rejects` for boundary-validation failures — so a sync throw must become a
 * rejected Promise rather than a synchronous exception.
 */
function runSync<T>(body: () => T): Promise<T> {
  try {
    return Promise.resolve(body());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Narrow a Vectorize metadata value to a number, or `undefined` if not numeric. */
function metadataNumber(
  metadata: Record<string, VectorizeMetadataValue> | undefined,
  key: string,
): number | undefined {
  if (metadata === undefined) return undefined;
  const value = metadata[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Creates a {@link MemoryRecordStorage} backed by Cloudflare Durable Object
 * SQLite (canonical) plus Vectorize (secondary index).
 *
 * **SQLite is canonical; Vectorize is a secondary index.** Every read that
 * surfaces content (`get`/`getMany`/`list`/`count`) goes straight to ACTIVE
 * SQLite rows scoped by `tenant_id` + `namespace`. `searchByVector` queries
 * Vectorize for nearest ids under a SERVER-OWNED `tenant_id` + `namespace`
 * filter, then REHYDRATES every hit from active SQLite rows — re-checking
 * tenant, namespace, AND version before surfacing content. A Vectorize hit that
 * is cross-tenant, wrong-namespace, stale-version, deleted/tombstoned, or absent
 * in SQLite is dropped during rehydration. Vectorize's own filter is never
 * trusted as the security boundary.
 *
 * **`tenantId` is REQUIRED.** It is supplied by Worker-side authenticated code,
 * never from a request payload; the backend validates a non-empty `tenantId` and
 * `namespace` at every scoped boundary.
 *
 * **Delete is a tombstone, in this order:** `delete`/`deleteNamespace` first
 * write `status: 'deleted'` rows in SQLite, THEN remove the ids from Vectorize.
 * Tombstone-before-index-delete bridges the Vectorize-rehydration consistency
 * window: a stale Vectorize hit for a tombstoned id is dropped on rehydration
 * because the canonical row is no longer active. This satisfies the shared
 * delete invariant — a deleted record vanishes from every read.
 *
 * **Vectorize metadata is server-owned and allowlisted** to `{ tenant_id,
 * namespace, memory_id, created_at, version }`. Caller content and arbitrary
 * caller metadata are NEVER written to Vectorize.
 */
export function createCloudflareMemoryRecordStorage(
  options: CreateCloudflareMemoryRecordStorageOptions,
): MemoryRecordStorage {
  const { sql, vectorize } = options;
  const table = options.tableName ?? DEFAULT_MEMORY_TABLE_NAME;

  /**
   * Validate and normalize a scope. `tenantId` and `namespace` are both required
   * and non-empty for this backend; the same check runs at every scoped
   * boundary so direct storage callers (not just createMemory) are guarded.
   */
  function requireScope(scope: MemoryRecordScope): { tenantId: string; namespace: string } {
    if (scope.tenantId === undefined || scope.tenantId.length === 0) {
      throw new Error('tenantId must be a non-empty string.');
    }
    if (scope.namespace.length === 0) {
      throw new Error('namespace must be a non-empty string.');
    }
    return { tenantId: scope.tenantId, namespace: scope.namespace };
  }

  /**
   * The server-owned, allowlisted Vectorize metadata for a record. Only these
   * fields ever leave for the secondary index — never content or caller metadata.
   */
  function vectorizeMetadata(
    tenantId: string,
    record: MemoryRecord,
  ): Record<string, VectorizeMetadataValue> {
    return {
      tenant_id: tenantId,
      namespace: record.namespace,
      memory_id: record.id,
      created_at: record.createdAt,
      version: record.version,
    };
  }

  /** Fetch a single ACTIVE row in scope, or `undefined`. */
  function activeRow(
    tenantId: string,
    namespace: string,
    id: string,
  ): z.infer<typeof storedRowSchema> | undefined {
    const rows = sql
      .exec<Record<string, SqlValue>>(
        `SELECT tenant_id, namespace, id, status, version, content, vector, metadata, created_at, updated_at
         FROM ${table}
         WHERE tenant_id = ? AND namespace = ? AND id = ? AND status = 'active'`,
        tenantId,
        namespace,
        id,
      )
      .toArray();
    const first = rows[0];
    return first === undefined ? undefined : storedRowSchema.parse(first);
  }

  return {
    init(): Promise<void> {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
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
      return Promise.resolve();
    },

    close(): Promise<void> {
      // No-op: the SQL and Vectorize bindings are injected and shared; this
      // backend is a non-owning view and must not dispose them.
      return Promise.resolve();
    },

    async put(record: MemoryRecord): Promise<void> {
      const { tenantId, namespace } = requireScope({
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      });
      const now = Date.now();
      sql.exec(
        `INSERT INTO ${table}
           (tenant_id, namespace, id, status, version, content, vector, metadata, created_at, updated_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, namespace, id) DO UPDATE SET
           status = excluded.status,
           version = excluded.version,
           content = excluded.content,
           vector = excluded.vector,
           metadata = excluded.metadata,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           indexed_at = excluded.indexed_at`,
        tenantId,
        namespace,
        record.id,
        record.status,
        record.version,
        record.content,
        JSON.stringify(Array.from(record.vector)),
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt,
        now,
      );

      if (record.status === 'active') {
        await vectorize.upsert([
          {
            id: record.id,
            values: Array.from(record.vector),
            metadata: vectorizeMetadata(tenantId, record),
          },
        ]);
      } else {
        // A directly put() non-active record is a tombstone: keep the secondary
        // index from holding a stale live id for it.
        await vectorize.deleteByIds([record.id]);
      }
    },

    // The reads below run synchronously against SQLite but return Promises (per
    // the contract). `runSync` turns a boundary-validation throw into a rejected
    // Promise so callers can use `.rejects`, without an async function that the
    // lint's require-await rule would flag for having no `await`.
    get(id: string, scope: MemoryRecordScope): Promise<MemoryRecord | undefined> {
      return runSync(() => {
        const { tenantId, namespace } = requireScope(scope);
        const row = activeRow(tenantId, namespace, id);
        return row === undefined ? undefined : rowToRecord(row);
      });
    },

    getMany(ids: string[], scope: MemoryRecordScope): Promise<MemoryRecord[]> {
      return runSync(() => {
        const { tenantId, namespace } = requireScope(scope);
        const out: MemoryRecord[] = [];
        for (const id of ids) {
          const row = activeRow(tenantId, namespace, id);
          if (row !== undefined) out.push(rowToRecord(row));
        }
        return out;
      });
    },

    list(
      scope: MemoryRecordScope,
      listOptions?: { limit?: number; offset?: number },
    ): Promise<MemoryRecord[]> {
      return runSync(() => {
        const { tenantId, namespace } = requireScope(scope);
        const rows = sql
          .exec<Record<string, SqlValue>>(
            `SELECT tenant_id, namespace, id, status, version, content, vector, metadata, created_at, updated_at
             FROM ${table}
             WHERE tenant_id = ? AND namespace = ? AND status = 'active'
             ORDER BY created_at DESC`,
            tenantId,
            namespace,
          )
          .toArray()
          .map((row) => rowToRecord(storedRowSchema.parse(row)));
        const offset = listOptions?.offset ?? 0;
        const limit = listOptions?.limit ?? rows.length;
        return rows.slice(offset, offset + limit);
      });
    },

    count(scope: MemoryRecordScope): Promise<number> {
      return runSync(() => {
        const { tenantId, namespace } = requireScope(scope);
        const rows = sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${table}
             WHERE tenant_id = ? AND namespace = ? AND status = 'active'`,
            tenantId,
            namespace,
          )
          .toArray();
        return rows[0]?.n ?? 0;
      });
    },

    async searchByVector(
      vector: EmbeddingVectorLike,
      scope: MemoryRecordScope,
      searchOptions: { limit: number; threshold?: number },
    ): Promise<MemoryVectorSearchResult[]> {
      const { tenantId, namespace } = requireScope(scope);
      const queryVector = Array.from(vector);

      // SECURITY-CRITICAL: the Vectorize filter is server-owned (tenant +
      // namespace). It is a best-effort narrowing, NOT the security boundary —
      // every returned id is re-scoped against canonical SQLite below.
      const result = await vectorize.query(queryVector, {
        topK: searchOptions.limit,
        filter: { tenant_id: tenantId, namespace },
        returnMetadata: true,
      });

      const hits: MemoryVectorSearchResult[] = [];
      for (const match of result.matches) {
        // REHYDRATE: the canonical active row for this id, in this exact scope.
        // This single scoped lookup drops cross-tenant, wrong-namespace,
        // deleted/tombstoned, and absent hits for free.
        const row = activeRow(tenantId, namespace, match.id);
        if (row === undefined) continue;

        // STALE-VERSION gate: the secondary index lags canonical writes, so a
        // hit whose advertised version disagrees with the canonical row is
        // stale and dropped. A non-numeric / missing advertised version is
        // treated as a mismatch.
        const advertisedVersion = metadataNumber(match.metadata, 'version');
        if (advertisedVersion === undefined || advertisedVersion !== row.version) continue;

        // Score comes from Vectorize; the record comes from canonical SQLite.
        if (searchOptions.threshold !== undefined && match.score < searchOptions.threshold)
          continue;
        hits.push({ id: match.id, score: match.score, record: rowToRecord(row) });
      }

      // Preserve Vectorize's descending-score order; bound to the limit.
      return hits.slice(0, searchOptions.limit);
    },

    async update(
      id: string,
      scope: MemoryRecordScope,
      patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
    ): Promise<MemoryRecord | undefined> {
      const { tenantId, namespace } = requireScope(scope);
      const row = activeRow(tenantId, namespace, id);
      if (row === undefined) return undefined;

      const existing = rowToRecord(row);
      const updated: MemoryRecord = {
        ...existing,
        content: patch.content ?? existing.content,
        vector: patch.vector ? new Float32Array(patch.vector) : existing.vector,
        metadata: patch.metadata ?? existing.metadata,
        updatedAt: Date.now(),
        version: existing.version + 1,
      };

      sql.exec(
        `UPDATE ${table}
           SET version = ?, content = ?, vector = ?, metadata = ?, updated_at = ?, indexed_at = ?
         WHERE tenant_id = ? AND namespace = ? AND id = ? AND status = 'active'`,
        updated.version,
        updated.content,
        JSON.stringify(Array.from(updated.vector)),
        JSON.stringify(updated.metadata),
        updated.updatedAt,
        updated.updatedAt,
        tenantId,
        namespace,
        id,
      );

      await vectorize.upsert([
        {
          id: updated.id,
          values: Array.from(updated.vector),
          metadata: vectorizeMetadata(tenantId, updated),
        },
      ]);

      return updated;
    },

    async delete(id: string, scope: MemoryRecordScope): Promise<boolean> {
      const { tenantId, namespace } = requireScope(scope);
      const row = activeRow(tenantId, namespace, id);
      if (row === undefined) return false;

      // Tombstone in SQLite FIRST, THEN delete from Vectorize. Ordering is
      // load-bearing: a stale Vectorize hit for this id is already dropped on
      // rehydration the instant the canonical row stops being active.
      const now = Date.now();
      sql.exec(
        `UPDATE ${table}
           SET status = 'deleted', updated_at = ?
         WHERE tenant_id = ? AND namespace = ? AND id = ?`,
        now,
        tenantId,
        namespace,
        id,
      );
      await vectorize.deleteByIds([id]);
      return true;
    },

    async deleteNamespace(scope: MemoryRecordScope): Promise<number> {
      const { tenantId, namespace } = requireScope(scope);

      // Count active rows BEFORE tombstoning; that count is what was removed.
      const idRows = sql
        .exec<{ id: string }>(
          `SELECT id FROM ${table}
           WHERE tenant_id = ? AND namespace = ? AND status = 'active'`,
          tenantId,
          namespace,
        )
        .toArray();
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return 0;

      const now = Date.now();
      sql.exec(
        `UPDATE ${table}
           SET status = 'deleted', updated_at = ?
         WHERE tenant_id = ? AND namespace = ? AND status = 'active'`,
        now,
        tenantId,
        namespace,
      );
      await vectorize.deleteByIds(ids);
      return ids.length;
    },
  };
}
