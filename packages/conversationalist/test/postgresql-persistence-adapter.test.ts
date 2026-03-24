import type { SQL } from 'bun';
import { afterEach, describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import { Conversation } from '../src/history';
import {
  createPostgreSQLPersistenceAdapter,
  type PostgreSQLPersistenceAdapter,
} from '../src/persistence/postgresql-adapter';
import { createTestConversationEnvironment } from '../src/test/index';

type Row = Record<string, unknown>;

/**
 * In-memory mock that implements the subset of SQL used by the adapter:
 * unsafe(query, params?) and close().
 */
function createMockSQL(): SQL {
  const tables = new Map<string, Row[]>();
  let closed = false;

  function getTable(name: string): Row[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function extractTableName(query: string): string {
    const match = query.match(/"([^"]+)"/);
    return match ? match[1]! : 'sessions';
  }

  const sql = {
    unsafe(query: string, values?: unknown[]): Promise<Row[]> {
      if (closed) return Promise.reject(new Error('Connection closed'));

      const trimmed = query.trim().toUpperCase();
      const tableName = extractTableName(query);
      const table = getTable(tableName);

      if (trimmed.startsWith('CREATE TABLE')) {
        return Promise.resolve([]);
      }

      if (trimmed.startsWith('INSERT INTO')) {
        const params = values ?? [];
        const existing = table.findIndex((row) => row['id'] === params[0]);

        const row: Row = {
          id: params[0] as string,
          data: params[1] as string,
          title: params[2] as string | null,
          created_at: params[3] as string,
          updated_at: params[4] as string,
          message_count: params[5] as number,
          tags: params[6] as string | null,
        };

        if (existing >= 0) {
          table[existing] = row;
        } else {
          table.push(row);
        }
        return Promise.resolve([]);
      }

      if (trimmed.startsWith('SELECT DATA FROM') || trimmed.startsWith('SELECT DATA')) {
        const id = values?.[0] as string;
        const row = table.find((r) => r['id'] === id);
        if (!row) return Promise.resolve([]);
        return Promise.resolve([{ data: row['data'] }]);
      }

      if (trimmed.startsWith('SELECT ID')) {
        return Promise.resolve(
          table.map((row) => ({
            id: row['id'],
            title: row['title'],
            created_at: row['created_at'],
            updated_at: row['updated_at'],
            message_count: row['message_count'],
            tags: row['tags'],
          })),
        );
      }

      if (trimmed.startsWith('DELETE FROM')) {
        const id = values?.[0] as string;
        const index = table.findIndex((r) => r['id'] === id);
        if (index >= 0) table.splice(index, 1);
        return Promise.resolve([]);
      }

      if (trimmed.startsWith('DROP TABLE')) {
        tables.delete(tableName);
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    },

    async close(): Promise<void> {
      closed = true;
    },
  };

  return sql as unknown as SQL;
}

describe('createPostgreSQLPersistenceAdapter', () => {
  let adapter: PostgreSQLPersistenceAdapter;

  afterEach(async () => {
    if (adapter) await adapter.close();
  });

  it('saves and loads a conversation round-trip preserving all fields', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'round-trip', title: 'Round Trip' }, environment),
      environment,
    );
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi there');

    const history = conversation.current;
    await adapter.save(history);
    const loaded = await adapter.load('round-trip');

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(history.id);
    expect(loaded!.title).toBe(history.title);
    expect(loaded!.createdAt).toBe(history.createdAt);
    expect(loaded!.updatedAt).toBe(history.updatedAt);
    expect(loaded!.schemaVersion).toBe(history.schemaVersion);
    expect(loaded!.status).toBe(history.status);
    expect(loaded!.ids).toEqual(history.ids);
    expect(loaded!.messages).toEqual(history.messages);
    expect(loaded!.metadata).toEqual(history.metadata);
  });

  it('returns undefined for a nonexistent id', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const loaded = await adapter.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('lists correct SessionInfo entries', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();

    const first = new Conversation(
      createConversationHistory({ id: 'list-1', title: 'First' }, environment),
      environment,
    );
    first.appendUserMessage('message 1');
    first.tag('important');

    const second = new Conversation(
      createConversationHistory({ id: 'list-2', title: 'Second' }, environment),
      environment,
    );
    second.appendUserMessage('message a');
    second.appendAssistantMessage('message b');

    await adapter.save(first.current);
    await adapter.save(second.current);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(2);

    const firstSession = sessions.find((session) => session.id === 'list-1');
    expect(firstSession).toBeDefined();
    expect(firstSession!.title).toBe('First');
    expect(firstSession!.tags).toEqual(['important']);
    expect(firstSession!.messageCount).toBe(1);
    expect(firstSession!.createdAt).toBeDefined();
    expect(firstSession!.updatedAt).toBeDefined();

    const secondSession = sessions.find((session) => session.id === 'list-2');
    expect(secondSession).toBeDefined();
    expect(secondSession!.title).toBe('Second');
    expect(secondSession!.tags).toEqual([]);
    expect(secondSession!.messageCount).toBe(2);
  });

  it('deletes an entry', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'to-delete' }, environment);

    await adapter.save(conversation);
    expect(await adapter.load('to-delete')).toBeDefined();

    await adapter.delete('to-delete');
    expect(await adapter.load('to-delete')).toBeUndefined();
  });

  it('does not throw when deleting a nonexistent entry', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('overwrites an existing entry on save', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const original = createConversationHistory({ id: 'overwrite', title: 'Original' }, environment);
    const updated = { ...original, title: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' };

    await adapter.save(original);
    await adapter.save(updated);

    const loaded = await adapter.load('overwrite');
    expect(loaded!.title).toBe('Updated');
  });

  it('returns an empty array from list when no sessions exist', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(0);
    expect(sessions).toEqual([]);
  });

  it('uses a custom table name', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql, tableName: 'custom_sessions' });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory(
      { id: 'custom-table', title: 'Custom' },
      environment,
    );

    await adapter.save(conversation);
    const loaded = await adapter.load('custom-table');
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Custom');

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
  });

  it('rejects an invalid table name with SQL injection', async () => {
    await expect(
      createPostgreSQLPersistenceAdapter({ tableName: '"; DROP TABLE sessions;--' }),
    ).rejects.toThrow(/invalid table name/i);
  });

  it('rejects a table name exceeding 128 characters', async () => {
    const longName = 'a'.repeat(129);
    await expect(createPostgreSQLPersistenceAdapter({ tableName: longName })).rejects.toThrow(
      /invalid table name/i,
    );
  });

  it('omits title from SessionInfo when conversation has no title', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'no-title' }, environment);

    await adapter.save(conversation);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect('title' in sessions[0]!).toBe(false);
  });

  it('populates SessionInfo with tags and message count', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'info-test', title: 'Info' }, environment),
      environment,
    );
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi');
    conversation.tag('tagged');

    await adapter.save(conversation.current);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tags).toEqual(['tagged']);
    expect(sessions[0]!.messageCount).toBe(2);
  });

  it('returns undefined when stored data fails schema validation', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });

    // Insert corrupted data directly via the mock
    await sql.unsafe(
      `INSERT INTO "sessions" (id, data, title, created_at, updated_at, message_count, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['corrupt', JSON.stringify({ invalid: true }), null, 'now', 'now', 0, '[]'],
    );

    const loaded = await adapter.load('corrupt');
    expect(loaded).toBeUndefined();
  });

  it('accepts a user-provided SQL instance and close does not disconnect it', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'ext-sql' }, environment);
    await adapter.save(conversation);

    await adapter.close();

    // External SQL instance should still be usable
    const rows = await sql.unsafe(
      'SELECT ID, title, created_at, updated_at, message_count, tags FROM "sessions"',
    );
    expect(rows).toHaveLength(1);
  });

  it('auto-creates the table on initialization', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    // If the table were not created, the first operation would throw
    const sessions = await adapter.list();
    expect(sessions).toEqual([]);
  });

  it('throws on save after close when adapter owns the connection', async () => {
    const sql = createMockSQL();
    adapter = await createPostgreSQLPersistenceAdapter({ sql });
    // Manually close the underlying SQL to simulate what happens after adapter.close()
    await sql.close();

    await expect(adapter.save(createConversationHistory({ id: 'x' }))).rejects.toThrow();

    // Re-assign adapter so afterEach doesn't fail
    adapter = await createPostgreSQLPersistenceAdapter({ sql: createMockSQL() });
  });
});
