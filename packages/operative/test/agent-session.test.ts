import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession, loadAgentSession, saveAgentSession } from '../src/agent-session';

/** In-memory text-value store for tests, backed by Weft's MemoryStorage. */
const createMockKeyValueStore = () => textValueStore(new MemoryStorage());

describe('createAgentSession', () => {
  it('generates an id when not provided', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
    });

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
  });

  it('uses the provided id', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'custom-id-123',
    });

    expect(session.id).toBe('custom-id-123');
  });

  it('sets createdAt and updatedAt timestamps', () => {
    const history = createConversationHistory();
    const before = new Date().toISOString();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
    });
    const after = new Date().toISOString();

    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
    expect(session.createdAt >= before).toBe(true);
    expect(session.createdAt <= after).toBe(true);
    expect(session.updatedAt >= before).toBe(true);
    expect(session.updatedAt <= after).toBe(true);
  });

  it('defaults metadata to an empty object', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
    });

    expect(session.metadata).toEqual({});
  });

  it('uses provided metadata', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      metadata: { key: 'value', count: 42 },
    });

    expect(session.metadata).toEqual({ key: 'value', count: 42 });
  });

  it('stores the agentName correctly', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'my-agent',
      conversationHistory: history,
    });

    expect(session.agentName).toBe('my-agent');
  });

  it('stores the conversationHistory reference', () => {
    const history = createConversationHistory();
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
    });

    expect(session.conversationHistory).toBe(history);
  });
});

describe('saveAgentSession', () => {
  it('stores agent session data in the key-value store', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'conv-1' });
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'conv-1',
      metadata: { role: 'assistant' },
    });

    await saveAgentSession(store, session);

    const raw = await store.get('agent-session:conv-1');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed['id']).toBe('conv-1');
    expect(parsed['agentName']).toBe('test-agent');
    expect(parsed['metadata']).toEqual({ role: 'assistant' });
    expect(parsed['createdAt']).toBe(session.createdAt);
    expect(typeof parsed['updatedAt']).toBe('string');
  });
});

describe('loadAgentSession', () => {
  it('reconstructs session from stored data', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'conv-1' });
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'conv-1',
      metadata: { role: 'assistant' },
    });

    await saveAgentSession(store, session);

    const loaded = await loadAgentSession(store, 'conv-1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('conv-1');
    expect(loaded!.agentName).toBe('test-agent');
    expect(loaded!.metadata).toEqual({ role: 'assistant' });
    expect(loaded!.createdAt).toBe(session.createdAt);
    expect(loaded!.conversationHistory).toBeDefined();
    expect(loaded!.conversationHistory.id).toBe('conv-1');
  });

  it('returns undefined for a nonexistent id', async () => {
    const store = createMockKeyValueStore();

    const loaded = await loadAgentSession(store, 'nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when the stored session JSON is invalid', async () => {
    const store = createMockKeyValueStore();

    await store.set('agent-session:broken', '{not valid json');

    const loaded = await loadAgentSession(store, 'broken');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when the stored session shape is incomplete', async () => {
    const store = createMockKeyValueStore();

    await store.set(
      'agent-session:broken-shape',
      JSON.stringify({
        id: 'broken-shape',
        agentName: 'test-agent',
      }),
    );

    const loaded = await loadAgentSession(store, 'broken-shape');
    expect(loaded).toBeUndefined();
  });

  it('preserves all fields in a save/load round-trip', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'round-trip' });
    const session = createAgentSession({
      agentName: 'round-trip-agent',
      conversationHistory: history,
      id: 'round-trip',
      metadata: { nested: { deep: true }, list: [1, 2, 3] },
    });

    await saveAgentSession(store, session);
    const loaded = await loadAgentSession(store, 'round-trip');

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.agentName).toBe(session.agentName);
    expect(loaded!.metadata).toEqual(session.metadata);
    expect(loaded!.createdAt).toBe(session.createdAt);
    // updatedAt may differ because saveAgentSession updates it
    expect(typeof loaded!.updatedAt).toBe('string');
    expect(loaded!.conversationHistory.id).toBe(history.id);
  });
});
