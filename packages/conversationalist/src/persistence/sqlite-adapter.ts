import { z } from 'zod';

import type { SessionInfo, SessionPersistenceAdapter } from '../environment';
import { conversationShape } from '../schemas';
import type { ConversationHistory } from '../types';

/**
 * Lenient conversation schema that tolerates extra keys from older/newer schema versions.
 */
const lenientConversationSchema = z.object(conversationShape).passthrough();

export interface SQLitePersistenceAdapterOptions {
  path: string;
  tableName?: string;
}

export interface SQLitePersistenceAdapter extends SessionPersistenceAdapter {
  close(): void;
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

function wrapSync<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function createSQLitePersistenceAdapter(
  options: SQLitePersistenceAdapterOptions,
): Promise<SQLitePersistenceAdapter> {
  const { Database } = await import('bun:sqlite');
  const tableName = options.tableName ?? 'sessions';
  validateTableName(tableName);
  const database = new Database(options.path);

  database.run(`
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

  const insertStatement = database.prepare(`
    INSERT OR REPLACE INTO "${tableName}" (id, data, title, created_at, updated_at, message_count, tags)
    VALUES ($id, $data, $title, $created_at, $updated_at, $message_count, $tags)
  `);

  const selectStatement = database.prepare(`SELECT data FROM "${tableName}" WHERE id = $id`);

  const listStatement = database.prepare(
    `SELECT id, title, created_at, updated_at, message_count, tags FROM "${tableName}"`,
  );

  const deleteStatement = database.prepare(`DELETE FROM "${tableName}" WHERE id = $id`);

  return {
    save(conversation: ConversationHistory): Promise<void> {
      return wrapSync(() => {
        const tags = (conversation.metadata['_tags'] as string[] | undefined) ?? [];
        insertStatement.run({
          $id: conversation.id,
          $data: JSON.stringify(conversation),
          $title: conversation.title ?? null,
          $created_at: conversation.createdAt,
          $updated_at: conversation.updatedAt,
          $message_count: conversation.ids.length,
          $tags: JSON.stringify(tags),
        });
      });
    },

    load(id: string): Promise<ConversationHistory | undefined> {
      return wrapSync(() => {
        const row = selectStatement.get({ $id: id }) as { data: string } | null;
        if (!row) return undefined;
        const parsed: unknown = JSON.parse(row.data);
        const result = lenientConversationSchema.safeParse(parsed);
        if (!result.success) return undefined;
        return result.data as ConversationHistory;
      });
    },

    list(): Promise<SessionInfo[]> {
      return wrapSync(() => {
        const rows = listStatement.all() as Array<{
          id: string;
          title: string | null;
          created_at: string;
          updated_at: string;
          message_count: number;
          tags: string | null;
        }>;

        return rows.map((row) => ({
          id: row.id,
          ...(row.title !== null ? { title: row.title } : {}),
          tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messageCount: row.message_count,
        }));
      });
    },

    delete(id: string): Promise<void> {
      return wrapSync(() => {
        deleteStatement.run({ $id: id });
      });
    },

    close(): void {
      database.close();
    },
  };
}
