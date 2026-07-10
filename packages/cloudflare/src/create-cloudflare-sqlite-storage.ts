import {
  type BatchOperation,
  type ConditionalBatchCondition,
  resolvePrefixRangeEnd,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from '@lostgradient/weft/storage/interface';

import type { Sql, SqlValue } from './sql';

/**
 * Options for {@link createCloudflareSqliteStorage}.
 */
export interface CreateCloudflareSqliteStorageOptions {
  /**
   * The injectable SQL surface. In production this is the Durable Object
   * `ctx.storage.sql` binding; in tests it is a bun:sqlite double (see
   * `cloudflare/test`'s `createSqliteDouble`).
   */
  sql: Sql;
  /**
   * The SQLite table name for the key/value rows. Defaults to `kv_store`.
   * Provide a custom name when multiple logical stores share one Durable
   * Object. Must be a valid SQL identifier (letters, digits, underscore; must
   * start with a letter or underscore, not a digit).
   */
  tableName?: string;
}

/** Default table name for {@link createCloudflareSqliteStorage}. */
export const DEFAULT_SQLITE_STORAGE_TABLE_NAME = 'kv_store';

/**
 * Value column is TEXT, not BLOB: Durable Object `SqlStorage.exec` accepts
 * `ArrayBuffer | string | number | null` bindings, but the shared test double
 * (`bun:sqlite`) and this adapter both narrow to {@link SqlValue} (`string |
 * number | null`) to keep one small, structurally-real interface for both. A
 * key/value `Storage` adapter stores arbitrary bytes, so values are
 * base64-encoded into TEXT rather than widening the shared `Sql` contract.
 */
function encodeBytes(value: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface KeyRangeQuery {
  sql: string;
  parameters: SqlValue[];
}

/**
 * Builds the `WHERE`/`ORDER BY`/`LIMIT` clause for a prefix scan, layering the
 * optional `gt`/`gte`/`lt`/`lte` bounds on top of the prefix's own lexicographic
 * range. Mirrors the range semantics of Weft's built-in SQLite adapters
 * (`gt`/`gte`/`lt`/`lte` narrow the prefix range; `reverse` flips key order).
 */
function buildKeyRangeConditions(
  prefix: string,
  options: ScanOptions,
): { conditions: string[]; parameters: SqlValue[] } {
  const conditions = ['key >= ? AND key < ?'];
  const parameters: SqlValue[] = [prefix, resolvePrefixRangeEnd(prefix)];
  if (options.gt !== undefined) {
    conditions.push('key > ?');
    parameters.push(options.gt);
  }
  if (options.gte !== undefined) {
    conditions.push('key >= ?');
    parameters.push(options.gte);
  }
  if (options.lt !== undefined) {
    conditions.push('key < ?');
    parameters.push(options.lt);
  }
  if (options.lte !== undefined) {
    conditions.push('key <= ?');
    parameters.push(options.lte);
  }
  return { conditions, parameters };
}

function buildScanQuery(table: string, prefix: string, options: ScanOptions = {}): KeyRangeQuery {
  const { conditions, parameters } = buildKeyRangeConditions(prefix, options);
  const direction = options.reverse ? 'DESC' : 'ASC';
  let sql = `SELECT key, value FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY key ${direction}`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    parameters.push(options.limit);
  }
  return { sql, parameters };
}

/**
 * Creates a Weft {@link Storage} adapter backed by Cloudflare Durable Object
 * SQLite (`ctx.storage.sql`). This is the Workers-native session-store
 * backend: wrap the result in `textValueStore()` (from
 * `@lostgradient/weft/storage/text-value-store`) to satisfy the
 * `ConditionalTextValueStore` contract that `operative`'s `createSessionStore`
 * requires, or use it directly anywhere a Weft `Storage` is expected.
 *
 * **Table shape.** One `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table.
 * Values are stored as base64 text (see {@link encodeBytes}) so the adapter can
 * share the same minimal {@link Sql} contract as the memory backend — no
 * `ArrayBuffer` binding required.
 *
 * **Capabilities.** `persistence: 'local'` (a Durable Object's SQLite storage
 * durably survives eviction and restarts, scoped to that DO instance).
 * `readAfterWrite: 'linearizable'` and `scanConsistency: 'snapshot'`: a Durable
 * Object serializes all synchronous storage calls made before the next
 * `await`, so a `conditionalBatch` or `scan` never observes a torn write.
 * `atomicBatch`/`conditionalBatch: true`: neither method issues an `await`
 * between its reads and its writes, so on real Durable Object storage the
 * whole call executes inside one automatic transaction (the platform commits
 * or rolls back everything written since the last `await` as a unit); on the
 * bun:sqlite test double the same holds because JavaScript is single-threaded
 * and nothing yields mid-call. `conditionalBatch` additionally checks every
 * precondition BEFORE issuing any write, so a failed precondition never
 * applies a partial write in the first place — no explicit `BEGIN`/`COMMIT`
 * is needed (Durable Object `SqlStorage.exec` does not support manual
 * transaction-control statements). `boundedRangeDelete: true`: `deletePrefix`
 * is a single ranged `DELETE`, not a scan-then-batch.
 */
export function createCloudflareSqliteStorage(
  options: CreateCloudflareSqliteStorageOptions,
): Storage {
  const { sql } = options;
  const table = options.tableName ?? DEFAULT_SQLITE_STORAGE_TABLE_NAME;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `tableName must be a valid SQL identifier (letters, digits, underscore; not starting with a digit); got "${table}".`,
    );
  }

  let initialized = false;
  function ensureTable(): void {
    if (initialized) return;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    );
    initialized = true;
  }

  function getRaw(key: string): string | null {
    const rows = sql
      .exec<{ value: SqlValue }>(`SELECT value FROM ${table} WHERE key = ?`, key)
      .toArray();
    const value = rows[0]?.value;
    return typeof value === 'string' ? value : null;
  }

  function putRaw(key: string, encoded: string): void {
    sql.exec(
      `INSERT INTO ${table} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      encoded,
    );
  }

  function deleteRaw(key: string): void {
    sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
  }

  function applyBatch(operations: BatchOperation[]): void {
    for (const operation of operations) {
      if (operation.type === 'put') {
        putRaw(operation.key, encodeBytes(operation.value));
      } else {
        deleteRaw(operation.key);
      }
    }
  }

  const storage: Storage = {
    capabilities(): StorageCapabilities {
      return {
        persistence: 'local',
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: true,
      };
    },

    get(key: string): Promise<Uint8Array | null> {
      ensureTable();
      const raw = getRaw(key);
      return Promise.resolve(raw === null ? null : decodeBytes(raw));
    },

    put(key: string, value: Uint8Array): Promise<void> {
      ensureTable();
      putRaw(key, encodeBytes(value));
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      ensureTable();
      deleteRaw(key);
      return Promise.resolve();
    },

    // `scan` must be an async generator to satisfy `Storage.scan`'s
    // `AsyncIterable` return type, but the read itself is synchronous SQLite
    // `exec`. Deliberately NOT adding an `await Promise.resolve()` here: that
    // would introduce a real yield point before the query runs, letting other
    // Durable Object work interleave ahead of it and undermining the
    // "synchronous before the next await" snapshot guarantee documented on
    // this adapter's capabilities.
    // eslint-disable-next-line @typescript-eslint/require-await
    async *scan(prefix: string, scanOptions?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
      ensureTable();
      const { sql: query, parameters } = buildScanQuery(table, prefix, scanOptions);
      const rows = sql.exec<{ key: string; value: string }>(query, ...parameters).toArray();
      for (const row of rows) {
        yield [row.key, decodeBytes(row.value)];
      }
    },

    batch(operations: BatchOperation[]): Promise<void> {
      ensureTable();
      applyBatch(operations);
      return Promise.resolve();
    },

    conditionalBatch(
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> {
      ensureTable();
      for (const condition of conditions) {
        const raw = getRaw(condition.key);
        const current = raw === null ? null : decodeBytes(raw);
        if (!bytesEqual(current, condition.expectedValue)) {
          return Promise.resolve(false);
        }
      }
      applyBatch(operations);
      return Promise.resolve(true);
    },

    has(key: string): Promise<boolean> {
      ensureTable();
      const rows = sql
        .exec<{ present: number }>(`SELECT 1 AS present FROM ${table} WHERE key = ? LIMIT 1`, key)
        .toArray();
      return Promise.resolve(rows.length > 0);
    },

    deletePrefix(prefix: string): Promise<number> {
      ensureTable();
      const rangeEnd = resolvePrefixRangeEnd(prefix);
      const before = sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM ${table} WHERE key >= ? AND key < ?`, prefix, rangeEnd)
        .toArray();
      const count = before[0]?.n ?? 0;
      sql.exec(`DELETE FROM ${table} WHERE key >= ? AND key < ?`, prefix, rangeEnd);
      return Promise.resolve(count);
    },

    async *keys(prefix: string, scanOptions?: ScanOptions): AsyncIterable<string> {
      for await (const [key] of storage.scan(prefix, scanOptions)) {
        yield key;
      }
    },

    count(prefix: string): Promise<number> {
      ensureTable();
      const rangeEnd = resolvePrefixRangeEnd(prefix);
      const rows = sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM ${table} WHERE key >= ? AND key < ?`, prefix, rangeEnd)
        .toArray();
      return Promise.resolve(rows[0]?.n ?? 0);
    },

    [Symbol.dispose](): void {
      // No-op: the `sql` binding is injected and shared with the rest of the
      // Durable Object; this adapter is a non-owning view and must not
      // dispose it.
    },
  };

  return storage;
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
