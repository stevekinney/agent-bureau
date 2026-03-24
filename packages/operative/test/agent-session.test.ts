import { describe, expect, it } from 'bun:test';
import { createConversationHistory, createInMemoryPersistenceAdapter } from 'conversationalist';

import { createAgentSession, loadAgentSession, saveAgentSession } from '../src/agent-session';

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
  it('stores _agentSession in history metadata', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const history = createConversationHistory({ id: 'conv-1' });
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'conv-1',
      metadata: { role: 'assistant' },
    });

    await saveAgentSession(adapter, session);

    const loaded = await adapter.load('conv-1');
    expect(loaded).toBeDefined();
    const agentSessionData = loaded!.metadata['_agentSession'] as Record<string, unknown>;
    expect(agentSessionData).toBeDefined();
    expect(agentSessionData['id']).toBe('conv-1');
    expect(agentSessionData['agentName']).toBe('test-agent');
    expect(agentSessionData['metadata']).toEqual({ role: 'assistant' });
    expect(agentSessionData['createdAt']).toBe(session.createdAt);
    expect(typeof agentSessionData['updatedAt']).toBe('string');
  });
});

describe('loadAgentSession', () => {
  it('reconstructs session from stored data', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const history = createConversationHistory({ id: 'conv-1' });
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'conv-1',
      metadata: { role: 'assistant' },
    });

    await saveAgentSession(adapter, session);

    const loaded = await loadAgentSession(adapter, 'conv-1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('conv-1');
    expect(loaded!.agentName).toBe('test-agent');
    expect(loaded!.metadata).toEqual({ role: 'assistant' });
    expect(loaded!.createdAt).toBe(session.createdAt);
    expect(loaded!.conversationHistory).toBeDefined();
    expect(loaded!.conversationHistory.id).toBe('conv-1');
  });

  it('returns undefined for a nonexistent id', async () => {
    const adapter = createInMemoryPersistenceAdapter();

    const loaded = await loadAgentSession(adapter, 'nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when no _agentSession metadata exists', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const history = createConversationHistory({ id: 'conv-no-meta' });
    await adapter.save(history);

    const loaded = await loadAgentSession(adapter, 'conv-no-meta');
    expect(loaded).toBeUndefined();
  });

  it('preserves all fields in a save/load round-trip', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const history = createConversationHistory({ id: 'round-trip' });
    const session = createAgentSession({
      agentName: 'round-trip-agent',
      conversationHistory: history,
      id: 'round-trip',
      metadata: { nested: { deep: true }, list: [1, 2, 3] },
    });

    await saveAgentSession(adapter, session);
    const loaded = await loadAgentSession(adapter, 'round-trip');

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
