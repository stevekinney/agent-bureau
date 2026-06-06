import { Database } from 'bun:sqlite';

import type { Sql, SqlCursor, SqlValue } from '../sql';

/**
 * A bun:sqlite-backed {@link Sql} double for tests.
 *
 * Cloudflare's Durable Object `SqlStorage` API (the production target) does not
 * exist under `bun:test`, so the backend takes an injectable {@link Sql}. This
 * double satisfies that interface with an in-memory `:memory:` SQLite database,
 * exercising the backend's real SQL — the same canonical store, run locally.
 *
 * The factory result is `Sql` plus a {@link SqliteDouble.close} to release the
 * underlying database between tests.
 */
export interface SqliteDouble extends Sql {
  /** Close the underlying in-memory database. */
  close(): void;
}

/**
 * Creates a bun:sqlite-backed {@link Sql} double over an in-memory database.
 */
export function createSqliteDouble(): SqliteDouble {
  const database = new Database(':memory:');

  return {
    exec<Row extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): SqlCursor<Row> {
      const statement = database.query<Row, SqlValue[]>(query);
      // `.all()` materializes SELECT rows and also drives mutations (returning
      // an empty array), matching the Durable Object cursor's `toArray()`.
      const rows = statement.all(...bindings);
      return {
        toArray(): Row[] {
          return rows;
        },
      };
    },

    close(): void {
      database.close();
    },
  };
}
