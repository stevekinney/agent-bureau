import type { KeyValueStore, KeyValueStoreOptions } from '../types';
import { withNamespace } from '../with-namespace';

/**
 * Minimal interface for bun:sqlite Database methods used by this adapter.
 * Declared inline to avoid importing types from bun:sqlite, which would
 * fail in non-Bun environments at type-check time.
 */
interface BunSQLiteStatement<Row = unknown> {
  get(...params: unknown[]): Row | null;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): { changes: number };
}

interface BunSQLiteDatabase {
  exec(sql: string): void;
  prepare<Row = unknown>(sql: string): BunSQLiteStatement<Row>;
  close(): void;
}

/** Options for creating a SQLite-backed key-value store. */
export interface SQLiteKeyValueStoreOptions extends KeyValueStoreOptions {
  /** Path to the SQLite database file. Use `:memory:` for in-memory databases. */
  filename: string;
}

/**
 * Escape SQL LIKE wildcards in a prefix string.
 *
 * The LIKE pattern uses `\` as the escape character (declared via `ESCAPE '\'`),
 * so literal `\`, `%`, and `_` in the prefix must be escaped.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Creates a SQLite-backed KeyValueStore using bun:sqlite.
 *
 * The database is created if it does not exist. WAL mode is enabled for
 * concurrent read performance. All operations use prepared statements.
 *
 * Requires Bun runtime. Use `isSQLiteAvailable()` to check before calling.
 */
export async function createSQLiteKeyValueStore(
  options: SQLiteKeyValueStoreOptions,
): Promise<KeyValueStore> {
  // Dynamic import avoids hard failure when this module is loaded outside Bun.
  const moduleName = 'bun:sqlite';
  const { Database } = (await import(moduleName)) as {
    Database: new (filename: string) => BunSQLiteDatabase;
  };

  const database = new Database(options.filename);

  database.exec('PRAGMA journal_mode=WAL');
  database.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const getStatement = database.prepare<{ value: string }>('SELECT value FROM kv WHERE key = ?');
  const setStatement = database.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
  const deleteStatement = database.prepare('DELETE FROM kv WHERE key = ?');
  const listStatement = database.prepare<{ key: string }>(
    "SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
  );
  const hasStatement = database.prepare<{ found: number }>(
    'SELECT 1 AS found FROM kv WHERE key = ? LIMIT 1',
  );
  const deletePrefixStatement = database.prepare("DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'");

  const store: KeyValueStore = {
    get(key: string): Promise<string | null> {
      const row = getStatement.get(key);
      return Promise.resolve(row ? row.value : null);
    },

    set(key: string, value: string): Promise<void> {
      setStatement.run(key, value);
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      deleteStatement.run(key);
      return Promise.resolve();
    },

    list(prefix: string): Promise<string[]> {
      const pattern = `${escapeLikePrefix(prefix)}%`;
      const rows = listStatement.all(pattern);
      return Promise.resolve(rows.map((row) => row.key));
    },

    has(key: string): Promise<boolean> {
      const row = hasStatement.get(key);
      return Promise.resolve(row !== null);
    },

    deletePrefix(prefix: string): Promise<number> {
      const pattern = `${escapeLikePrefix(prefix)}%`;
      const result = deletePrefixStatement.run(pattern);
      return Promise.resolve(result.changes);
    },

    close(): Promise<void> {
      database.close();
      return Promise.resolve();
    },
  };

  if (options.namespace) {
    return withNamespace(store, options.namespace);
  }

  return store;
}

/**
 * Check whether the SQLite adapter can be used in the current runtime.
 * Returns `true` when running under Bun.
 */
export function isSQLiteAvailable(): boolean {
  return typeof globalThis.Bun !== 'undefined';
}
