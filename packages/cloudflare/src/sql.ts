/**
 * The minimal SQL surface the Cloudflare memory backend needs.
 *
 * Modeled on Cloudflare Durable Objects' `SqlStorage.exec` so the real
 * `ctx.storage.sql` binding satisfies this interface structurally with no
 * adapter. A bun:sqlite-backed double (see `src/test/sqlite-double.ts`) satisfies
 * the same shape for tests. Keep this tiny: the backend uses only `exec` with
 * positional bindings and the cursor's `toArray()`.
 */

/**
 * A single bound parameter value. Durable Object SQLite accepts
 * `ArrayBuffer | string | number | null`; this backend stores the dense vector
 * and metadata as JSON strings and timestamps/versions as numbers, so it never
 * needs `ArrayBuffer`. Narrowing to these three keeps the double honest.
 */
export type SqlValue = string | number | null;

/**
 * The cursor returned by {@link Sql.exec}. Only `toArray()` is used: the backend
 * reads whole result sets (scoped, bounded by `limit`) rather than streaming.
 */
export interface SqlCursor<Row extends Record<string, SqlValue>> {
  /** Materialize every result row into an array. */
  toArray(): Row[];
}

/**
 * The injectable SQL interface. In production this is the Durable Object
 * `ctx.storage.sql` binding; in tests it is a bun:sqlite double.
 */
export interface Sql {
  /**
   * Execute a SQL statement with positional bindings, returning a cursor over
   * the result rows. Mutations return an empty result set.
   */
  exec<Row extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row>;
}
