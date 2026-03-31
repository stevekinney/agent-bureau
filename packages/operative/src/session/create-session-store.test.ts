import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { createMemoryKeyValueStore, type KeyValueStore } from 'storage';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';

function makeSession(overrides: {
  agentName?: string;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}) {
  const session = createAgentSession({
    agentName: overrides.agentName ?? 'test-agent',
    conversationHistory: createConversationHistory(),
    id: overrides.id,
  });

  if (overrides.createdAt) session.createdAt = overrides.createdAt;
  if (overrides.updatedAt) session.updatedAt = overrides.updatedAt;

  return session;
}

function createStoreWithoutHas(): KeyValueStore {
  const store = createMemoryKeyValueStore();
  return {
    get: store.get.bind(store),
    set: store.set.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
  };
}

describe('createSessionStore', () => {
  it('save/load round trip preserves session data', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const session = makeSession({ agentName: 'round-trip-agent' });

    await store.save(session);
    const loaded = await store.load(session.id);

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.agentName).toBe('round-trip-agent');
    expect(loaded!.conversationHistory).toEqual(session.conversationHistory);
  });

  it('load returns undefined for nonexistent session', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const loaded = await store.load('does-not-exist');
    expect(loaded).toBeUndefined();
  });

  it('load returns undefined for malformed stored session data', async () => {
    const rawStore = createMemoryKeyValueStore();
    const store = createSessionStore(rawStore);

    await rawStore.set('agent-session:broken', '{not valid json');
    expect(await store.load('broken')).toBeUndefined();

    await rawStore.set(
      'agent-session:broken',
      JSON.stringify({
        id: 'broken',
        agentName: 'test-agent',
        conversationHistory: createConversationHistory(),
        createdAt: 'not-a-date',
        updatedAt: 'also-not-a-date',
      }),
    );
    expect(await store.load('broken')).toBeUndefined();
  });

  it('delete removes a session', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const session = makeSession({});

    await store.save(session);
    expect(await store.load(session.id)).toBeDefined();

    await store.delete(session.id);
    expect(await store.load(session.id)).toBeUndefined();
  });

  it('delete is a no-op for nonexistent session', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    // Should not throw
    await store.delete('nonexistent');
  });

  it('exists returns true for saved sessions', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const session = makeSession({});

    await store.save(session);
    expect(await store.exists(session.id)).toBe(true);
  });

  it('exists returns false for missing sessions', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    expect(await store.exists('missing')).toBe(false);
  });

  it('falls back to get() when the underlying store does not implement has()', async () => {
    const rawStore = createStoreWithoutHas();
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'fallback-has' });

    await store.save(session);

    expect(await store.exists('fallback-has')).toBe(true);
    expect(await store.exists('missing')).toBe(false);
  });

  it('list returns sorted summaries by updatedAt descending by default', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    const s1 = makeSession({
      id: 'session-1',
      agentName: 'agent-a',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const s2 = makeSession({
      id: 'session-2',
      agentName: 'agent-b',
      createdAt: '2025-01-02T00:00:00.000Z',
      updatedAt: '2025-01-03T00:00:00.000Z',
    });
    const s3 = makeSession({
      id: 'session-3',
      agentName: 'agent-a',
      createdAt: '2025-01-03T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    });

    await store.save(s1);
    await store.save(s2);
    await store.save(s3);

    const summaries = await store.list();

    expect(summaries).toHaveLength(3);
    // Default: updatedAt descending
    expect(summaries[0]!.id).toBe('session-2');
    expect(summaries[1]!.id).toBe('session-3');
    expect(summaries[2]!.id).toBe('session-1');
  });

  it('list filters by agentName', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    const s1 = makeSession({ id: 'a-1', agentName: 'agent-alpha' });
    const s2 = makeSession({ id: 'b-1', agentName: 'agent-beta' });
    const s3 = makeSession({ id: 'a-2', agentName: 'agent-alpha' });

    await store.save(s1);
    await store.save(s2);
    await store.save(s3);

    const summaries = await store.list({ agentName: 'agent-alpha' });
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.agentName === 'agent-alpha')).toBe(true);
  });

  it('list respects limit and offset', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    for (let i = 0; i < 5; i++) {
      const s = makeSession({
        id: `s-${i}`,
        updatedAt: new Date(2025, 0, i + 1).toISOString(),
      });
      await store.save(s);
    }

    const page = await store.list({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });

  it('list sorts by createdAt ascending', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    const s1 = makeSession({
      id: 'first',
      createdAt: '2025-06-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    });
    const s2 = makeSession({
      id: 'second',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    await store.save(s1);
    await store.save(s2);

    const summaries = await store.list({ sortBy: 'createdAt', sortOrder: 'asc' });
    expect(summaries[0]!.id).toBe('second');
    expect(summaries[1]!.id).toBe('first');
  });

  it('updateMetadata merges metadata without overwriting conversation', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const session = makeSession({});
    session.metadata = { existing: 'value' };

    await store.save(session);
    await store.updateMetadata(session.id, { newKey: 'newValue' });

    const loaded = await store.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual({ existing: 'value', newKey: 'newValue' });
    // Conversation should be untouched
    expect(loaded!.conversationHistory).toEqual(session.conversationHistory);
  });

  it('updateMetadata is a no-op for nonexistent session', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    // Should not throw
    await store.updateMetadata('nonexistent', { key: 'value' });
  });

  it('cleanup deletes old sessions and returns count', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    const old = makeSession({
      id: 'old-session',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const recent = makeSession({
      id: 'recent-session',
      updatedAt: new Date().toISOString(),
    });

    await store.save(old);
    await store.save(recent);

    // Delete sessions older than 1 day
    const deleted = await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 });
    expect(deleted).toBe(1);

    expect(await store.exists('old-session')).toBe(false);
    expect(await store.exists('recent-session')).toBe(true);
  });

  it('cleanup filters by agentName', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());

    const oldA = makeSession({
      id: 'old-a',
      agentName: 'agent-a',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const oldB = makeSession({
      id: 'old-b',
      agentName: 'agent-b',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    await store.save(oldA);
    await store.save(oldB);

    const deleted = await store.cleanup({
      olderThan: 24 * 60 * 60 * 1000,
      agentName: 'agent-a',
    });
    expect(deleted).toBe(1);

    expect(await store.exists('old-a')).toBe(false);
    expect(await store.exists('old-b')).toBe(true);
  });

  it('all keys use the agent-session: prefix in the underlying store', async () => {
    const kv = createMemoryKeyValueStore();
    const store = createSessionStore(kv);
    const session = makeSession({ id: 'prefix-test' });

    await store.save(session);

    const keys = await kv.list('agent-session:');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('agent-session:'))).toBe(true);
  });

  it('list returns correct messageCount from conversation history', async () => {
    const store = createSessionStore(createMemoryKeyValueStore());
    const history = createConversationHistory();
    // The conversation history starts with empty messages array
    const session = createAgentSession({
      agentName: 'counter-agent',
      conversationHistory: history,
    });

    await store.save(session);
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.messageCount).toBe(0);
  });
});
