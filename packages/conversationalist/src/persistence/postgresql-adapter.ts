import { z } from 'zod';

import type { SessionInfo, SessionPersistenceAdapter } from '../environment';
import { conversationShape } from '../schemas';
import type { ConversationHistory } from '../types';

/**
 * Lenient conversation schema that tolerates extra keys from older/newer schema versions.
 */
const lenientConversationSchema = z.object(conversationShape).passthrough();

export interface PostgreSQLPersistenceAdapterOptions {
  sql?: import('bun').SQL;
  url?: string;
  tableName?: string;
}

export interface PostgreSQLPersistenceAdapter extends SessionPersistenceAdapter {
  close(): Promise<void>;
}

const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_TABLE_NAME_LENGTH = 128;

function validateTableName(name: string): void {
  if (name.length > MAX_TABLE_NAME_LENGTH || !TABLE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid table name "${name}": must match ${TABLE_NAME_PATTERN.source} and be at most ${MAX_TABLE_NAME_LENGTH} characters`,
    );
  }
}

export async function createPostgreSQLPersistenceAdapter(
  options: PostgreSQLPersistenceAdapterOptions = {},
): Promise<PostgreSQLPersistenceAdapter> {
  const { SQL } = await import('bun');
  const tableName = options.tableName ?? 'sessions';
  validateTableName(tableName);

  const ownsConnection = !options.sql;
  /* v8 ignore next */
  const sql =
    options.sql ??
    new SQL(options.url ?? Bun.env['DATABASE_URL'] ?? 'postgres://localhost/sessions');

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      tags TEXT
    )
  `);

  return {
    async save(conversation: ConversationHistory): Promise<void> {
      const tags = (conversation.metadata['_tags'] as string[] | undefined) ?? [];

      await sql.unsafe(
        `INSERT INTO "${tableName}" (id, data, title, created_at, updated_at, message_count, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           data = EXCLUDED.data,
           title = EXCLUDED.title,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           message_count = EXCLUDED.message_count,
           tags = EXCLUDED.tags`,
        [
          conversation.id,
          JSON.stringify(conversation),
          conversation.title ?? null,
          conversation.createdAt,
          conversation.updatedAt,
          conversation.ids.length,
          JSON.stringify(tags),
        ],
      );
    },

    async load(id: string): Promise<ConversationHistory | undefined> {
      const rows: Array<{ data: string }> = await sql.unsafe(
        `SELECT data FROM "${tableName}" WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return undefined;

      const parsed: unknown = JSON.parse(rows[0]!.data);
      const result = lenientConversationSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return result.data as ConversationHistory;
    },

    async list(): Promise<SessionInfo[]> {
      const rows: Array<{
        id: string;
        title: string | null;
        created_at: string;
        updated_at: string;
        message_count: number;
        tags: string | null;
      }> = await sql.unsafe(
        `SELECT id, title, created_at, updated_at, message_count, tags FROM "${tableName}"`,
      );

      return rows.map((row) => ({
        id: row.id,
        ...(row.title !== null ? { title: row.title } : {}),
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
      }));
    },

    async delete(id: string): Promise<void> {
      await sql.unsafe(`DELETE FROM "${tableName}" WHERE id = $1`, [id]);
    },

    async close(): Promise<void> {
      /* v8 ignore next */
      if (ownsConnection) await sql.close();
    },
  };
}
