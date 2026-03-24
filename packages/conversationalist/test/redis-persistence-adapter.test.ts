import type { RedisClient } from 'bun';
import { afterEach, describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import { Conversation } from '../src/history';
import {
  createRedisPersistenceAdapter,
  type RedisPersistenceAdapter,
} from '../src/persistence/redis-adapter';
import { createTestConversationEnvironment } from '../src/test/index';

/**
 * In-memory mock that implements the subset of RedisClient used by the adapter:
 * send(command, args) and close().
 */
function createMockRedisClient(): RedisClient {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const expiries = new Map<string, number>();
  let closed = false;

  return {
    send(command: string, args: string[]): Promise<unknown> {
      if (closed) return Promise.reject(new Error('Connection closed'));
      const cmd = command.toUpperCase();

      if (cmd === 'HSET') {
        const [key, ...fieldValues] = args;
        if (!hashes.has(key!)) hashes.set(key!, new Map());
        const hash = hashes.get(key!)!;
        for (let i = 0; i < fieldValues.length; i += 2) {
          hash.set(fieldValues[i]!, fieldValues[i + 1]!);
        }
        return Promise.resolve(fieldValues.length / 2);
      }

      if (cmd === 'HGET') {
        const [key, field] = args;
        const hash = hashes.get(key!);
        if (!hash) return Promise.resolve(null);
        return Promise.resolve(hash.get(field!) ?? null);
      }

      if (cmd === 'HMGET') {
        const [key, ...fields] = args;
        const hash = hashes.get(key!);
        if (!hash) return Promise.resolve(fields.map(() => null));
        return Promise.resolve(fields.map((f) => hash.get(f!) ?? null));
      }

      if (cmd === 'SADD') {
        const [key, ...members] = args;
        if (!sets.has(key!)) sets.set(key!, new Set());
        const set = sets.get(key!)!;
        for (const m of members) set.add(m!);
        return Promise.resolve(members.length);
      }

      if (cmd === 'SMEMBERS') {
        const [key] = args;
        const set = sets.get(key!);
        return Promise.resolve(set ? [...set] : []);
      }

      if (cmd === 'SREM') {
        const [key, ...members] = args;
        const set = sets.get(key!);
        if (!set) return Promise.resolve(0);
        let removed = 0;
        for (const m of members) {
          if (set.delete(m!)) removed++;
        }
        return Promise.resolve(removed);
      }

      if (cmd === 'DEL') {
        let deleted = 0;
        for (const key of args) {
          if (hashes.delete(key!)) deleted++;
          sets.delete(key!);
          expiries.delete(key!);
        }
        return Promise.resolve(deleted);
      }

      if (cmd === 'EXPIRE') {
        const [key, seconds] = args;
        if (hashes.has(key!) || sets.has(key!)) {
          expiries.set(key!, Number(seconds));
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }

      if (cmd === 'TTL') {
        const [key] = args;
        const ttl = expiries.get(key!);
        if (ttl !== undefined) return Promise.resolve(ttl);
        if (hashes.has(key!) || sets.has(key!)) return Promise.resolve(-1);
        return Promise.resolve(-2);
      }

      if (cmd === 'PING') {
        return Promise.resolve('PONG');
      }

      return Promise.resolve(null);
    },
    close() {
      closed = true;
    },
  } as unknown as RedisClient;
}

/**
 * Creates a mock client that simulates expired hashes for stale-entry testing.
 * After `expireAfterCalls` HSET operations, all hashes are cleared (simulating TTL expiry)
 * but the index set remains.
 */
function createMockRedisClientWithExpiry(expireAfterCalls: number): RedisClient {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  let hsetCount = 0;
  let expired = false;

  function maybeExpire() {
    if (!expired && hsetCount >= expireAfterCalls) {
      expired = true;
      hashes.clear();
    }
  }

  return {
    send(command: string, args: string[]): Promise<unknown> {
      const cmd = command.toUpperCase();

      if (cmd === 'HSET') {
        const [key, ...fieldValues] = args;
        if (!hashes.has(key!)) hashes.set(key!, new Map());
        const hash = hashes.get(key!)!;
        for (let i = 0; i < fieldValues.length; i += 2) {
          hash.set(fieldValues[i]!, fieldValues[i + 1]!);
        }
        hsetCount++;
        return Promise.resolve(fieldValues.length / 2);
      }

      if (cmd === 'SADD') {
        const [key, ...members] = args;
        if (!sets.has(key!)) sets.set(key!, new Set());
        const set = sets.get(key!)!;
        for (const m of members) set.add(m!);
        return Promise.resolve(members.length);
      }

      if (cmd === 'EXPIRE') {
        return Promise.resolve(1);
      }

      // Before reads, simulate expiry
      maybeExpire();

      if (cmd === 'HGET') {
        const [key, field] = args;
        const hash = hashes.get(key!);
        if (!hash) return Promise.resolve(null);
        return Promise.resolve(hash.get(field!) ?? null);
      }

      if (cmd === 'HMGET') {
        const [key, ...fields] = args;
        const hash = hashes.get(key!);
        if (!hash) return Promise.resolve(fields.map(() => null));
        return Promise.resolve(fields.map((f) => hash.get(f!) ?? null));
      }

      if (cmd === 'SMEMBERS') {
        const [key] = args;
        const set = sets.get(key!);
        return Promise.resolve(set ? [...set] : []);
      }

      if (cmd === 'SREM') {
        const [key, ...members] = args;
        const set = sets.get(key!);
        if (!set) return Promise.resolve(0);
        let removed = 0;
        for (const m of members) {
          if (set.delete(m!)) removed++;
        }
        return Promise.resolve(removed);
      }

      if (cmd === 'DEL') {
        let deleted = 0;
        for (const key of args) {
          if (hashes.delete(key!)) deleted++;
          sets.delete(key!);
        }
        return Promise.resolve(deleted);
      }

      return Promise.resolve(null);
    },
    close() {},
  } as unknown as RedisClient;
}

describe('createRedisPersistenceAdapter', () => {
  let adapter: RedisPersistenceAdapter;

  afterEach(() => {
    if (adapter) adapter.close();
  });

  it('saves and loads a conversation round-trip preserving all fields', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
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
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const loaded = await adapter.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('lists correct SessionInfo entries', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
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
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'to-delete' }, environment);

    await adapter.save(conversation);
    expect(await adapter.load('to-delete')).toBeDefined();

    await adapter.delete('to-delete');
    expect(await adapter.load('to-delete')).toBeUndefined();
  });

  it('does not throw when deleting a nonexistent entry', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('overwrites an existing entry on save', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const environment = createTestConversationEnvironment();
    const original = createConversationHistory({ id: 'overwrite', title: 'Original' }, environment);
    const updated = { ...original, title: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' };

    await adapter.save(original);
    await adapter.save(updated);

    const loaded = await adapter.load('overwrite');
    expect(loaded!.title).toBe('Updated');
  });

  it('returns an empty array from list when no sessions exist', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(0);
    expect(sessions).toEqual([]);
  });

  it('uses a custom key prefix', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client, keyPrefix: 'custom_sessions' });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory(
      { id: 'custom-prefix', title: 'Custom' },
      environment,
    );

    await adapter.save(conversation);
    const loaded = await adapter.load('custom-prefix');
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Custom');

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
  });

  it('rejects an invalid key prefix with special characters', async () => {
    await expect(
      createRedisPersistenceAdapter({ keyPrefix: '"; DROP TABLE sessions;--' }),
    ).rejects.toThrow(/invalid key prefix/i);
  });

  it('rejects a key prefix exceeding 128 characters', async () => {
    const longName = 'a'.repeat(129);
    await expect(createRedisPersistenceAdapter({ keyPrefix: longName })).rejects.toThrow(
      /invalid key prefix/i,
    );
  });

  it('omits title from SessionInfo when conversation has no title', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'no-title' }, environment);

    await adapter.save(conversation);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect('title' in sessions[0]!).toBe(false);
  });

  it('populates SessionInfo with tags and message count', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
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
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });

    // Write invalid data directly via the mock client
    await client.send('HSET', ['sessions:corrupt', 'data', JSON.stringify({ invalid: true })]);
    await client.send('SADD', ['sessions:_index', 'corrupt']);

    const loaded = await adapter.load('corrupt');
    expect(loaded).toBeUndefined();
  });

  it('accepts a user-provided client and close does not disconnect it', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'ext-client' }, environment);
    await adapter.save(conversation);

    adapter.close();

    // External client should still be usable
    const pong = await client.send('PING', []);
    expect(pong).toBe('PONG');
  });

  it('respects timeToLive by setting TTL on the key', async () => {
    const client = createMockRedisClient();
    adapter = await createRedisPersistenceAdapter({ client, timeToLive: 300 });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'ttl-test' }, environment);

    await adapter.save(conversation);

    const ttl = (await client.send('TTL', ['sessions:ttl-test'])) as number;
    expect(ttl).toBe(300);
  });

  it('list cleans up stale index entries from expired hashes', async () => {
    const client = createMockRedisClientWithExpiry(1);
    adapter = await createRedisPersistenceAdapter({ client, timeToLive: 1 });
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'stale-entry' }, environment);

    await adapter.save(conversation);

    // The mock expires hashes after the first HSET, so list() sees nulls
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(0);

    // The stale ID should have been removed from the index
    const members = (await client.send('SMEMBERS', ['sessions:_index'])) as string[];
    expect(members).toHaveLength(0);
  });
});
