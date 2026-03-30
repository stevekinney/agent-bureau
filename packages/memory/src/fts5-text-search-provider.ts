import { extractKeywords } from './query-expansion';
import type { TextSearchProvider } from './text-search-provider';

/**
 * Checks whether the FTS5 text search provider can run in the current
 * environment. FTS5 relies on `bun:sqlite`, which is only available
 * in the Bun runtime.
 */
export function isFts5Available(): boolean {
  return typeof globalThis.Bun !== 'undefined';
}

export interface Fts5TextSearchProviderOptions {
  /** Path to the SQLite database file, or ':memory:' for in-memory. */
  filename: string;
  /** FTS5 virtual table name. Default: 'memory_fts' */
  tableName?: string;
}

/** Minimal interface for the bun:sqlite Database instance. */
interface BunSQLiteDatabase {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  query(sql: string): {
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

interface FtsRow {
  id: string;
  rank: number;
}

/**
 * Converts a BM25 rank (negative, lower = more relevant) to a [0, 1) score.
 */
function bm25RankToScore(rank: number): number {
  const relevance = -rank;
  return relevance / (1 + relevance);
}

/**
 * Builds an FTS5 MATCH query from raw text.
 *
 * Extracts keywords and joins them with OR. Falls back to individual
 * term matching (OR) if no keywords are extracted.
 */
function buildFtsQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const keywords = extractKeywords(trimmed);
  if (keywords.length > 0) {
    // Quote each keyword to avoid FTS5 syntax issues.
    return keywords.map((k) => `"${k}"`).join(' OR ');
  }

  // Fall back to individual term matching (OR) to align with the in-memory
  // BM25 fallback, which tokenizes the raw query and matches any term.
  // Strip double quotes to avoid producing malformed FTS5 MATCH syntax
  // (e.g. a raw query `is "the"` would otherwise produce `""the""`).
  const terms = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  if (terms.length > 0) return terms.join(' OR ');

  // Last resort: strip quotes from the entire input and wrap it.
  const sanitized = trimmed.replace(/"/g, '');
  return sanitized.length > 0 ? `"${sanitized}"` : null;
}

/**
 * Creates a TextSearchProvider backed by SQLite FTS5.
 *
 * Opens its own `bun:sqlite` connection to the given database file.
 * This is safe with WAL mode when sharing a file with SQLiteStorageAdapter.
 */
/**
 * Validates that a SQLite identifier contains only safe characters
 * (alphanumeric and underscores) to prevent SQL injection when
 * interpolating table names into queries.
 */
function validateSQLiteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid SQLite identifier "${name}": must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
    );
  }
  return name;
}

export function createFts5TextSearchProvider(
  options: Fts5TextSearchProviderOptions,
): TextSearchProvider {
  const { filename, tableName: rawTableName = 'memory_fts' } = options;
  const tableName = validateSQLiteIdentifier(rawTableName);
  let database: BunSQLiteDatabase | null = null;

  return {
    async init(): Promise<void> {
      if (database) return;

      if (!isFts5Available()) {
        throw new Error(
          'FTS5 text search requires the Bun runtime (bun:sqlite). ' +
            'In non-Bun environments, use createSQLiteMemory({ disableFts5: true }) ' +
            'to fall back to the pure-TypeScript BM25 text search provider.',
        );
      }

      const moduleName = 'bun:sqlite';
      const { Database } = (await import(/* webpackIgnore: true */ moduleName)) as {
        Database: new (filename: string) => BunSQLiteDatabase;
      };

      database = new Database(filename);
      database.exec('PRAGMA journal_mode=WAL');
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
        USING fts5(content, id UNINDEXED, namespace UNINDEXED)
      `);
    },

    close(): Promise<void> {
      if (database) {
        database.close();
        database = null;
      }
      return Promise.resolve();
    },

    index(id: string, content: string, namespace: string): Promise<void> {
      if (!database) throw new Error('FTS5 provider not initialized. Call init() first.');

      // Delete any existing entry to avoid duplicates, then insert.
      database.run(`DELETE FROM ${tableName} WHERE id = ?`, [id]);
      database.run(`INSERT INTO ${tableName} (id, content, namespace) VALUES (?, ?, ?)`, [
        id,
        content,
        namespace,
      ]);
      return Promise.resolve();
    },

    remove(id: string): Promise<void> {
      if (!database) throw new Error('FTS5 provider not initialized. Call init() first.');
      database.run(`DELETE FROM ${tableName} WHERE id = ?`, [id]);
      return Promise.resolve();
    },

    clear(namespace?: string): Promise<void> {
      if (!database) throw new Error('FTS5 provider not initialized. Call init() first.');
      if (namespace) {
        database.run(`DELETE FROM ${tableName} WHERE namespace = ?`, [namespace]);
      } else {
        database.run(`DELETE FROM ${tableName}`);
      }
      return Promise.resolve();
    },

    search(query: string, namespace: string): Promise<Map<string, number>> {
      if (!database) throw new Error('FTS5 provider not initialized. Call init() first.');

      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return Promise.resolve(new Map<string, number>());

      try {
        const rows = database
          .query(
            `SELECT id, bm25(${tableName}) AS rank
             FROM ${tableName}
             WHERE ${tableName} MATCH ? AND namespace = ?`,
          )
          .all(ftsQuery, namespace) as FtsRow[];

        const scores = new Map<string, number>();
        for (const row of rows) {
          scores.set(row.id, bm25RankToScore(row.rank));
        }
        return Promise.resolve(scores);
      } catch {
        // FTS5 MATCH can fail on malformed queries — return empty results.
        return Promise.resolve(new Map<string, number>());
      }
    },
  };
}
