import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore, SessionConflictError } from './create-session-store';

const SUMMARY_INDEX_KEY = 'agent-session:summary-index';
const BODY_PREFIX = 'agent-session-v2:body:';

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

async function seedStoredSession(
  store: ReturnType<typeof textValueStore>,
  session: ReturnType<typeof makeSession>,
): Promise<void> {
  await store.set(`agent-session:${session.id}`, JSON.stringify(session));
}

function summaryIndexPayload(id: string): string {
  return JSON.stringify({
    formatVersion: 1,
    summaries: {
      [id]: {
        id,
        agentName: 'test-agent',
        messageCount: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
    },
  });
}

function persistedConversationHistory(
  conversationHistory: ReturnType<typeof createConversationHistory>,
) {
  return JSON.parse(JSON.stringify(conversationHistory));
}

describe('createSessionStore', () => {
  it('exposes a specific error for repeated session save conflicts', () => {
    const error = new SessionConflictError('session-1');

    expect(error.name).toBe('SessionConflictError');
    expect(error.code).toBe('SessionConflictError');
    expect(error.message).toContain('session-1');
    expect(error.message).toContain('committed');
  });

  it('save/load round trip preserves session data', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ agentName: 'round-trip-agent' });

    await store.save(session);
    const loaded = await store.load(session.id);

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.agentName).toBe('round-trip-agent');
    expect(loaded!.conversationHistory).toEqual(
      persistedConversationHistory(session.conversationHistory),
    );
    expect(loaded!.revision).toBe(1);
  });

  it('round-trips an empty session id through an index rebuild', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    const session = makeSession({ id: '' });

    await store.save(session);
    await backing.delete(SUMMARY_INDEX_KEY);

    const summaries = await store.list({ limit: 10 });
    const loaded = await store.load('');
    expect(summaries.map((summary) => summary.id)).toEqual(['']);
    expect(loaded?.id).toBe('');
  });

  it('round-trips an id containing an unpaired UTF-16 surrogate', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    const id = `surrogate-${String.fromCharCode(0xd800)}`;

    await store.save(makeSession({ id }));

    const loaded = await store.load(id);
    const summaries = await store.list({ limit: 10 });
    expect(loaded?.id).toBe(id);
    expect(await store.exists(id)).toBe(true);
    expect(summaries.map((summary) => summary.id)).toEqual([id]);
    await store.delete(id);
    expect(await store.exists(id)).toBe(false);
  });

  it('ignores malformed encoded body keys during index rebuilds', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    await backing.set(
      'agent-session-v2:body:000g',
      JSON.stringify(makeSession({ id: String.fromCharCode(0) })),
    );

    expect(await store.list({ limit: 10 })).toEqual([]);
    expect(await backing.has('agent-session-v2:body:000g')).toBe(true);
  });

  it('keeps legacy id body:x distinct from new id x', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    const legacyId = 'body:x';
    const newId = 'x';

    await backing.set(`agent-session:${legacyId}`, JSON.stringify(makeSession({ id: legacyId })));
    await store.save(makeSession({ id: newId }));

    const loadedLegacy = await store.load(legacyId);
    const loadedNew = await store.load(newId);
    const summaries = await store.list({ limit: 10 });
    expect(loadedLegacy?.id).toBe(legacyId);
    expect(loadedNew?.id).toBe(newId);
    expect(summaries.map((summary) => summary.id)).toEqual(
      expect.arrayContaining([legacyId, newId]),
    );

    await store.delete(legacyId);
    expect(await store.load(legacyId)).toBeUndefined();
    const remaining = await store.load(newId);
    expect(remaining?.id).toBe(newId);
  });

  it('delete removes both current and legacy representations of one id', async () => {
    const backing = textValueStore(new MemoryStorage());
    const store = createSessionStore(backing);
    const id = 'dual';
    const session = makeSession({ id });
    await backing.set('agent-session-v2:body:006400750061006c', JSON.stringify(session));
    await backing.set(`agent-session:${id}`, JSON.stringify(session));

    await store.delete(id);

    expect(await backing.has('agent-session-v2:body:006400750061006c')).toBe(false);
    expect(await backing.has(`agent-session:${id}`)).toBe(false);
    expect(await store.load(id)).toBeUndefined();
  });

  it('merges stale concurrent conversation writers instead of dropping turns', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'concurrent-session' });
    await store.save(session);

    const firstWriter = await store.load(session.id);
    const secondWriter = await store.load(session.id);
    expect(firstWriter).toBeDefined();
    expect(secondWriter).toBeDefined();

    const firstConversation = new Conversation(firstWriter!.conversationHistory);
    firstConversation.appendUserMessage('first writer');
    const secondConversation = new Conversation(secondWriter!.conversationHistory);
    secondConversation.appendUserMessage('second writer');

    await store.save({
      ...firstWriter!,
      conversationHistory: firstConversation.current,
    });
    await store.save({
      ...secondWriter!,
      conversationHistory: secondConversation.current,
    });

    const loaded = await store.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.revision).toBe(3);
    const contents = loaded!.conversationHistory.ids.map(
      (id) => loaded!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('first writer');
    expect(contents).toContain('second writer');
    expect(
      loaded!.conversationHistory.ids.map(
        (id, index) => loaded!.conversationHistory.messages[id]!.position === index,
      ),
    ).toEqual([true, true]);
  });

  it('does not exhaust save retries for unrelated concurrent sessions', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession({ id: `unrelated-concurrent-${index}` }),
    );

    await Promise.all(sessions.map((session) => store.save(session)));

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toHaveLength(sessions.length);
  });

  it('preserves metadata and conversation updates that interleave', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'metadata-conversation-session' });
    session.metadata = { existing: 'value' };
    await store.save(session);

    const conversationWriter = await store.load(session.id);
    expect(conversationWriter).toBeDefined();
    const conversation = new Conversation(conversationWriter!.conversationHistory);
    conversation.appendUserMessage('conversation update');

    await store.updateMetadata(session.id, { newKey: 'newValue' });
    await store.save({
      ...conversationWriter!,
      conversationHistory: conversation.current,
    });

    const loaded = await store.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual({ existing: 'value', newKey: 'newValue' });
    const contents = loaded!.conversationHistory.ids.map(
      (id) => loaded!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('conversation update');
  });

  it('does not let stale saves revert existing metadata keys', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-metadata-session' });
    session.metadata = { status: 'old' };
    await store.save(session);

    const staleWriter = await store.load(session.id);
    expect(staleWriter).toBeDefined();

    await store.updateMetadata(session.id, { status: 'new' });
    await store.save({
      ...staleWriter!,
      metadata: { ...staleWriter!.metadata, staleOnly: true },
    });

    const loaded = await store.load(session.id);
    expect(loaded!.metadata).toEqual({ status: 'new', staleOnly: true });
  });

  it('lets fresh saves remove metadata keys', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'fresh-metadata-delete-session' });
    session.metadata = { keep: true, remove: true };
    await store.save(session);

    const freshWriter = await store.load(session.id);
    expect(freshWriter).toBeDefined();

    await store.save({
      ...freshWriter!,
      metadata: { keep: true },
    });

    const loaded = await store.load(session.id);
    expect(loaded!.metadata).toEqual({ keep: true });
  });

  it('keeps a saved session object fresh for a later save', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'save-resave-session' });
    session.metadata = { status: 'first' };
    await store.save(session);

    session.metadata = { status: 'second' };
    await store.save(session);

    const loaded = await store.load(session.id);
    expect(session.revision).toBe(2);
    expect(loaded!.revision).toBe(2);
    expect(loaded!.metadata).toEqual({ status: 'second' });
  });

  it('lets fresh saves remove run refs', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'fresh-run-delete-session' });
    session.runs = [
      {
        runId: 'fresh-run-delete-session:0',
        sequence: 0,
        status: 'completed',
        startedAt: '2025-01-01T00:00:00.000Z',
        agentName: 'test-agent',
      },
      {
        runId: 'fresh-run-delete-session:1',
        sequence: 1,
        status: 'completed',
        startedAt: '2025-01-01T00:00:01.000Z',
        agentName: 'test-agent',
      },
    ];
    await store.save(session);

    const freshWriter = await store.load(session.id);
    expect(freshWriter).toBeDefined();
    await store.save({
      ...freshWriter!,
      runs: [freshWriter!.runs[1]!],
    });

    const loaded = await store.load(session.id);
    expect(loaded!.runs.map((run) => run.runId)).toEqual(['fresh-run-delete-session:1']);
  });

  it('lets fresh saves replace existing conversation messages', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'fresh-conversation-edit-session' });
    const conversation = new Conversation(session.conversationHistory);
    conversation.appendUserMessage('original');
    session.conversationHistory = conversation.current;
    await store.save(session);

    const freshWriter = await store.load(session.id);
    expect(freshWriter).toBeDefined();
    const messageId = freshWriter!.conversationHistory.ids[0]!;

    await store.save({
      ...freshWriter!,
      conversationHistory: {
        ...freshWriter!.conversationHistory,
        messages: {
          ...freshWriter!.conversationHistory.messages,
          [messageId]: {
            ...freshWriter!.conversationHistory.messages[messageId]!,
            content: 'redacted',
          },
        },
      },
    });

    const loaded = await store.load(session.id);
    expect(loaded!.conversationHistory.messages[messageId]!.content).toBe('redacted');
  });

  it('does not let stale saves revert conversation metadata keys', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-conversation-metadata-session' });
    session.conversationHistory = {
      ...session.conversationHistory,
      metadata: { status: 'old' },
    };
    await store.save(session);

    const staleWriter = await store.load(session.id);
    expect(staleWriter).toBeDefined();

    await store.update(session.id, (latestSession) =>
      latestSession
        ? {
            ...latestSession,
            conversationHistory: {
              ...latestSession.conversationHistory,
              metadata: { status: 'new' },
            },
          }
        : undefined,
    );

    const conversation = new Conversation(staleWriter!.conversationHistory);
    conversation.appendUserMessage('stale writer');
    await store.save({
      ...staleWriter!,
      conversationHistory: {
        ...conversation.current,
        metadata: { ...conversation.current.metadata, staleOnly: true },
      },
    });

    const loaded = await store.load(session.id);
    expect(loaded!.conversationHistory.metadata).toEqual({ status: 'new', staleOnly: true });
  });

  it('allows an asynchronous updater to mutate another session in the same store', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const primary = makeSession({ id: 'reentrant-update-primary' });
    const nested = makeSession({ id: 'reentrant-update-nested' });
    await store.save(primary);

    const updated = await store.update(primary.id, async (current) => {
      await store.save(nested);
      return current ? { ...current, metadata: { updated: true } } : undefined;
    });

    expect(updated?.metadata).toEqual({ updated: true });
    expect(await store.load(nested.id)).toBeDefined();
  });

  it('does not let stale saves revert current run statuses', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-run-session' });
    session.runs = [
      {
        runId: 'stale-run-session:0',
        sequence: 0,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        agentName: 'test-agent',
      },
    ];
    await store.save(session);

    const staleWriter = await store.load(session.id);
    expect(staleWriter).toBeDefined();

    await store.update(session.id, (latestSession) =>
      latestSession
        ? {
            ...latestSession,
            runs: latestSession.runs.map((run) =>
              run.runId === 'stale-run-session:0' ? { ...run, status: 'completed' } : run,
            ),
          }
        : undefined,
    );
    await store.save({
      ...staleWriter!,
      metadata: { staleOnly: true },
    });

    const loaded = await store.load(session.id);
    expect(loaded!.runs[0]!.status).toBe('completed');
    expect(loaded!.metadata).toEqual({ staleOnly: true });
  });

  it('does not let stale saves revert the current agent name', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-agent-session', agentName: 'old-agent' });
    await store.save(session);

    const staleWriter = await store.load(session.id);
    expect(staleWriter).toBeDefined();

    await store.update(session.id, (latestSession) =>
      latestSession ? { ...latestSession, agentName: 'new-agent' } : undefined,
    );
    await store.save(staleWriter!);

    const loaded = await store.load(session.id);
    expect(loaded!.agentName).toBe('new-agent');
  });

  it('refreshes updatedAt on save', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({
      id: 'save-timestamp-session',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    await store.save(session);

    const loaded = await store.load(session.id);
    expect(loaded!.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
  });

  it('load returns undefined for nonexistent session', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const loaded = await store.load('does-not-exist');
    expect(loaded).toBeUndefined();
  });

  it('load returns undefined for malformed stored session data', async () => {
    const rawStore = textValueStore(new MemoryStorage());
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

  it('reads legacy sessions without revision as revision 0', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const legacySession = makeSession({ id: 'legacy-session' });
    const { revision: _revision, ...legacyPayload } = legacySession;
    await rawStore.set('agent-session:legacy-session', JSON.stringify(legacyPayload));

    const loaded = await store.load('legacy-session');
    expect(loaded).toBeDefined();
    expect(loaded!.revision).toBe(0);
  });

  it('merges saves for legacy sessions without runs', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const legacySession = makeSession({ id: 'legacy-session-without-runs' });
    const { revision: _revision, runs: _runs, ...legacyPayload } = legacySession;
    await rawStore.set('agent-session:legacy-session-without-runs', JSON.stringify(legacyPayload));

    const loaded = await store.load('legacy-session-without-runs');
    expect(loaded).toBeDefined();
    expect(loaded!.revision).toBe(0);
    expect(loaded!.runs).toEqual([]);

    const conversation = new Conversation(loaded!.conversationHistory);
    conversation.appendUserMessage('legacy writer');

    await store.save({
      ...loaded!,
      conversationHistory: conversation.current,
    });

    const saved = await store.load('legacy-session-without-runs');
    expect(saved).toBeDefined();
    expect(saved!.revision).toBe(1);
    expect(saved!.runs).toEqual([]);
    expect(
      saved!.conversationHistory.ids.map((id) => saved!.conversationHistory.messages[id]!.content),
    ).toEqual(['legacy writer']);
  });

  it('delete removes a session', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({});

    await store.save(session);
    expect(await store.load(session.id)).toBeDefined();

    await store.delete(session.id);
    expect(await store.load(session.id)).toBeUndefined();
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(false);
  });

  it('delete is a no-op for nonexistent session', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    // Should not throw
    await store.delete('nonexistent');
  });

  it('delete cleans up an orphan summary when the session body is missing', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await rawStore.set(SUMMARY_INDEX_KEY, summaryIndexPayload('orphan-session'));

    await store.delete('orphan-session');

    expect(await rawStore.has('agent-session:orphan-session')).toBe(false);
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(false);
  });

  it('exists returns true for saved sessions', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({});

    await store.save(session);
    expect(await store.exists(session.id)).toBe(true);
  });

  it('exists returns false for missing sessions', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    expect(await store.exists('missing')).toBe(false);
  });

  it('list returns sorted summaries by updatedAt descending by default', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);

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

    await seedStoredSession(rawStore, s1);
    await seedStoredSession(rawStore, s2);
    await seedStoredSession(rawStore, s3);

    const summaries = await store.list();

    expect(summaries).toHaveLength(3);
    // Default: updatedAt descending
    expect(summaries[0]!.id).toBe('session-2');
    expect(summaries[1]!.id).toBe('session-3');
    expect(summaries[2]!.id).toBe('session-1');
  });

  it('lists current-format sessions through the summary index without reading bodies', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    const getKeys: string[] = [];
    let listCalls = 0;
    const instrumentedStore = {
      ...backingStore,
      list: async (prefix?: string) => {
        listCalls += 1;
        return backingStore.list(prefix ?? '');
      },
      get: async (key: string) => {
        getKeys.push(key);
        return backingStore.get(key);
      },
    };
    const store = createSessionStore(instrumentedStore);

    for (let index = 0; index < 25; index += 1) {
      await store.save(makeSession({ id: `indexed-${index}` }));
    }
    getKeys.length = 0;
    listCalls = 0;

    const summaries = await store.list({ limit: 5 });

    expect(summaries).toHaveLength(5);
    expect(getKeys).toHaveLength(6);
    expect(getKeys[0]).toBe(SUMMARY_INDEX_KEY);
    expect(getKeys.filter((key) => key.startsWith(BODY_PREFIX))).toHaveLength(5);
    expect(listCalls).toBe(0);

    const smallerBackingStore = textValueStore(new MemoryStorage());
    const smallerGetKeys: string[] = [];
    let smallerListCalls = 0;
    const smallerInstrumentedStore = {
      ...smallerBackingStore,
      list: async (prefix?: string) => {
        smallerListCalls += 1;
        return smallerBackingStore.list(prefix ?? '');
      },
      get: async (key: string) => {
        smallerGetKeys.push(key);
        return smallerBackingStore.get(key);
      },
    };
    const smallerStore = createSessionStore(smallerInstrumentedStore);
    for (let index = 0; index < 5; index += 1) {
      await smallerStore.save(makeSession({ id: `small-${index}` }));
    }
    smallerGetKeys.length = 0;
    smallerListCalls = 0;
    await smallerStore.list({ limit: 5 });
    expect(smallerGetKeys).toHaveLength(6);
    expect(smallerGetKeys[0]).toBe(SUMMARY_INDEX_KEY);
    expect(smallerListCalls).toBe(0);
  });

  it('does not list an orphan summary when its session body is missing', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await rawStore.set(SUMMARY_INDEX_KEY, summaryIndexPayload('orphan-session'));

    expect(await store.list()).toEqual([]);
    expect(await rawStore.get(SUMMARY_INDEX_KEY)).toBe(
      JSON.stringify({ formatVersion: 1, summaries: {} }),
    );

    const retained = makeSession({ id: 'after-orphan-repair' });
    await store.save(retained);
    const afterRepair = await store.list();
    expect(afterRepair.map((summary) => summary.id)).toEqual([retained.id]);
  });

  it('does not advertise an indexed summary whose body id does not match', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const indexed = makeSession({ id: 'indexed-id' });
    const different = makeSession({ id: 'different-id' });
    await rawStore.set(`agent-session:${indexed.id}`, JSON.stringify(different));
    await rawStore.set(SUMMARY_INDEX_KEY, summaryIndexPayload(indexed.id));

    expect(await store.list({ limit: 10 })).toEqual([]);
    expect(JSON.parse((await rawStore.get(SUMMARY_INDEX_KEY))!).summaries).not.toHaveProperty(
      indexed.id,
    );
    expect(await rawStore.has(`agent-session:${indexed.id}`)).toBe(true);
  });

  it('bounds default listing reads to the default page size', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    const getKeys: string[] = [];
    const instrumentedStore = {
      ...backingStore,
      get: async (key: string) => {
        getKeys.push(key);
        return backingStore.get(key);
      },
    };
    const store = createSessionStore(instrumentedStore);
    for (let index = 0; index < 125; index += 1) {
      await store.save(makeSession({ id: `default-page-${index}` }));
    }
    getKeys.length = 0;

    const summaries = await store.list();

    expect(summaries).toHaveLength(100);
    expect(getKeys).toHaveLength(101);
    expect(getKeys[0]).toBe(SUMMARY_INDEX_KEY);
  });

  it('keeps a concurrent save that wins during orphan repair', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const concurrentStore = createSessionStore(rawStore);
    const concurrent = makeSession({ id: 'concurrent-repair-session' });
    const orphanIndex = summaryIndexPayload('orphan-session');
    await rawStore.set(SUMMARY_INDEX_KEY, orphanIndex);
    let injectSave = true;
    const instrumentedStore = {
      ...rawStore,
      conditionalBatch: async (
        conditions: Parameters<typeof rawStore.conditionalBatch>[0],
        operations: Parameters<typeof rawStore.conditionalBatch>[1],
      ) => {
        const repairsIndex = operations.some(
          (operation) => operation.type === 'set' && operation.key === SUMMARY_INDEX_KEY,
        );
        if (
          injectSave &&
          repairsIndex &&
          conditions.some(
            (condition) =>
              condition.key === SUMMARY_INDEX_KEY && condition.expectedValue === orphanIndex,
          )
        ) {
          injectSave = false;
          await concurrentStore.save(concurrent);
        }
        return rawStore.conditionalBatch(conditions, operations);
      },
    };
    const store = createSessionStore(instrumentedStore);

    const summaries = await store.list();

    expect(summaries).toEqual([]);
    expect(JSON.parse((await rawStore.get(SUMMARY_INDEX_KEY))!).summaries).toHaveProperty(
      concurrent.id,
    );
    const repairedSummaries = await store.list();
    expect(repairedSummaries.map((summary) => summary.id)).toEqual([concurrent.id]);
  });

  it('rebuilds array-shaped malformed indexes before list, save, and update', async () => {
    for (const malformed of ['[]', '{"formatVersion":1,"summaries":[]}']) {
      for (const operation of ['list', 'save', 'update'] as const) {
        const rawStore = textValueStore(new MemoryStorage());
        const store = createSessionStore(rawStore);
        const retained = makeSession({ id: `${operation}-retained` });
        const changed = makeSession({ id: `${operation}-changed` });
        await store.save(retained);
        await store.save(changed);
        await rawStore.set(SUMMARY_INDEX_KEY, malformed);

        if (operation === 'list') {
          await store.list();
        } else if (operation === 'save') {
          await store.save({ ...changed, agentName: 'updated-agent' });
        } else {
          await store.update(changed.id, (session) =>
            session ? { ...session, agentName: 'updated-agent' } : undefined,
          );
        }

        const summaries = await store.list();
        const ids = summaries.map((summary) => summary.id);
        expect(ids).toContain(retained.id);
        expect(ids).toContain(changed.id);
      }
    }
  });

  it('treats the top-level summary index version as authoritative', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'authoritative-version' });
    await seedStoredSession(rawStore, session);
    await rawStore.set(
      SUMMARY_INDEX_KEY,
      JSON.stringify({
        formatVersion: 1,
        summaries: {
          [session.id]: {
            id: session.id,
            agentName: session.agentName,
            messageCount: 0,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            metadata: {},
            formatVersion: 999,
          },
        },
      }),
    );

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toEqual([session.id]);
  });

  it('reports an accurate conflict when delete cannot commit', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    const session = makeSession({ id: 'delete-conflict' });
    await backingStore.set(`agent-session:${session.id}`, JSON.stringify(session));
    await backingStore.set(SUMMARY_INDEX_KEY, summaryIndexPayload(session.id));
    const conflictingStore = {
      ...backingStore,
      conditionalBatch: async () => false,
    };
    const store = createSessionStore(conflictingStore);

    let error: unknown;
    try {
      await store.delete(session.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'SessionConflictError',
      message: expect.stringContaining('deleted'),
    });
    expect(await backingStore.has(`agent-session:${session.id}`)).toBe(true);
    expect(await backingStore.has(SUMMARY_INDEX_KEY)).toBe(true);
  });

  it('uses the session id as a deterministic tie-break in either sort direction', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    for (const id of ['same-c', 'same-a', 'same-b']) {
      await seedStoredSession(
        rawStore,
        makeSession({
          id,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        }),
      );
    }

    const ascending = await store.list({ sortOrder: 'asc' });
    expect(ascending.map((summary) => summary.id)).toEqual(['same-a', 'same-b', 'same-c']);
    const descending = await store.list({ sortOrder: 'desc' });
    expect(descending.map((summary) => summary.id)).toEqual(['same-c', 'same-b', 'same-a']);
  });

  it('orders canonically equivalent Unicode ids by code units', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const composed = makeSession({
      id: 'same-\u00e9',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const decomposed = makeSession({
      id: 'same-e\u0301',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    await seedStoredSession(rawStore, composed);
    await seedStoredSession(rawStore, decomposed);

    const ascending = await store.list({ sortOrder: 'asc' });
    expect(ascending.map((summary) => summary.id)).toEqual([decomposed.id, composed.id]);
    const descending = await store.list({ sortOrder: 'desc' });
    expect(descending.map((summary) => summary.id)).toEqual([composed.id, decomposed.id]);
  });

  it('backfills a missing legacy summary index on the first list', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'legacy-index-session' });
    await seedStoredSession(rawStore, session);

    const summaries = await store.list();
    expect(summaries[0]!.id).toBe(session.id);
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(true);
    const backfilled = await store.list();
    expect(backfilled[0]!.messageCount).toBe(0);
  });

  it('backfills a legacy session whose id matches the reserved index suffix', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'summary-index' });
    await seedStoredSession(rawStore, session);

    const summaries = await store.list();

    expect(summaries.map((summary) => summary.id)).toEqual([session.id]);
    expect(await store.load(session.id)).toBeDefined();
    expect(await rawStore.get(SUMMARY_INDEX_KEY)).toContain('"summaries"');
  });

  it('migrates the reserved legacy id on a direct read before list is called', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'summary-index' });
    const other = makeSession({ id: 'other-legacy-session' });
    await seedStoredSession(rawStore, session);
    await seedStoredSession(rawStore, other);

    const migrated = await store.load(session.id);
    expect(migrated?.id).toBe(session.id);
    await store.updateMetadata(session.id, { migrated: true });
    const updated = await store.load(session.id);
    expect(updated?.metadata).toEqual({ migrated: true });
    expect(await rawStore.get(SUMMARY_INDEX_KEY)).toContain('"summaries"');
    const summaries = await store.list({ limit: 10 });
    expect(summaries.map((summary) => summary.id)).toEqual(
      expect.arrayContaining([session.id, other.id]),
    );
  });

  it('migrates the reserved legacy id before saving an unrelated session', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const reserved = makeSession({ id: 'summary-index' });
    await seedStoredSession(rawStore, reserved);

    await store.save(makeSession({ id: 'unrelated-session' }));

    const loadedReserved = await store.load(reserved.id);
    const summaries = await store.list({ limit: 10 });
    expect(loadedReserved?.id).toBe(reserved.id);
    expect(summaries.map(({ id }) => id)).toEqual(
      expect.arrayContaining([reserved.id, 'unrelated-session']),
    );
  });

  it('exists migrates the reserved legacy id so cleanup can expire it', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({
      id: 'summary-index',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    await seedStoredSession(rawStore, session);

    expect(await store.exists(session.id)).toBe(true);
    expect(await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 })).toBe(1);
    expect(await store.exists(session.id)).toBe(false);
  });

  it('does not read or overwrite the old un-namespaced collision key', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'namespaced-index' });
    const unrelatedValue = 'client-owned-value';
    await rawStore.set('agent-session-index', unrelatedValue);
    await seedStoredSession(rawStore, session);

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toEqual([session.id]);
    expect(await rawStore.get('agent-session-index')).toBe(unrelatedValue);
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(true);
  });

  it('rejects an occupied v2 body key without overwriting client data', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({ id: 'occupied' });
    const occupiedKey = `${BODY_PREFIX}${[...session.id]
      .map((character) => character.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')}`;
    await rawStore.set(occupiedKey, 'client-owned-value');

    expect(store.save(session)).rejects.toThrow(/occupied by unrelated data/);
    expect(await rawStore.get(occupiedKey)).toBe('client-owned-value');
    expect(store.delete(session.id)).rejects.toThrow(/occupied by unrelated data/);
    expect(await rawStore.get(occupiedKey)).toBe('client-owned-value');
  });

  it('does not replace a concurrent save during legacy index rebuild', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const retained = makeSession({ id: 'legacy-retained' });
    const concurrent = makeSession({ id: 'legacy-concurrent' });
    await seedStoredSession(rawStore, retained);
    const concurrentStore = createSessionStore(rawStore);
    let injectSave = true;
    const instrumentedStore = {
      ...rawStore,
      conditionalBatch: async (
        conditions: Parameters<typeof rawStore.conditionalBatch>[0],
        operations: Parameters<typeof rawStore.conditionalBatch>[1],
      ) => {
        const rebuildsIndex = operations.some(
          (operation) => operation.type === 'set' && operation.key === SUMMARY_INDEX_KEY,
        );
        if (
          injectSave &&
          rebuildsIndex &&
          conditions.some(
            (condition) => condition.key === SUMMARY_INDEX_KEY && condition.expectedValue === null,
          )
        ) {
          injectSave = false;
          await concurrentStore.save(concurrent);
        }
        return rawStore.conditionalBatch(conditions, operations);
      },
    };
    const store = createSessionStore(instrumentedStore);

    const summaries = await store.list();
    const ids = summaries.map((summary) => summary.id);

    expect(ids).toHaveLength(2);
    expect(ids).toContain(retained.id);
    expect(ids).toContain(concurrent.id);
    expect(JSON.parse((await rawStore.get(SUMMARY_INDEX_KEY))!).summaries).toHaveProperty(
      concurrent.id,
    );
  });

  it('rebuilds a malformed index before save, update, or delete', async () => {
    for (const operation of ['save', 'update', 'delete'] as const) {
      const rawStore = textValueStore(new MemoryStorage());
      const store = createSessionStore(rawStore);
      const retained = makeSession({ id: `${operation}-retained` });
      const changed = makeSession({ id: `${operation}-changed` });
      await store.save(retained);
      await store.save(changed);
      await rawStore.set(SUMMARY_INDEX_KEY, '{"summaries":{"broken":null}}');

      if (operation === 'save') {
        await store.save({ ...changed, agentName: 'updated-agent' });
      } else if (operation === 'update') {
        await store.update(changed.id, (session) =>
          session ? { ...session, agentName: 'updated-agent' } : undefined,
        );
      } else {
        await store.delete(changed.id);
      }

      const summaries = await store.list();
      expect(summaries.map((summary) => summary.id)).toContain(retained.id);
      if (operation === 'delete') {
        expect(summaries.map((summary) => summary.id)).not.toContain(changed.id);
      } else {
        expect(summaries.map((summary) => summary.id)).toContain(changed.id);
      }
    }
  });

  it('list filters by agentName', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));

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
    const store = createSessionStore(textValueStore(new MemoryStorage()));

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
    const store = createSessionStore(textValueStore(new MemoryStorage()));

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
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({});
    session.metadata = { existing: 'value' };

    await store.save(session);
    await store.updateMetadata(session.id, { newKey: 'newValue' });

    const loaded = await store.load(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.metadata).toEqual({ existing: 'value', newKey: 'newValue' });
    // Conversation should be untouched
    expect(loaded!.conversationHistory).toEqual(
      persistedConversationHistory(session.conversationHistory),
    );
  });

  it('updateMetadata is a no-op for nonexistent session', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    // Should not throw
    await store.updateMetadata('nonexistent', { key: 'value' });
  });

  it('rejects an updater result with a different session id', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'original-id' });
    await store.save(session);

    expect(
      store.update(session.id, (current) =>
        current ? { ...current, id: 'different-id' } : undefined,
      ),
    ).rejects.toThrow(/returned id "different-id"/);
    const loaded = await store.load(session.id);
    expect(loaded?.id).toBe(session.id);
    expect(await store.load('different-id')).toBeUndefined();
  });

  it('cleanup deletes old sessions and returns count', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);

    const old = makeSession({
      id: 'old-session',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const recent = makeSession({
      id: 'recent-session',
      updatedAt: new Date().toISOString(),
    });

    await seedStoredSession(rawStore, old);
    await seedStoredSession(rawStore, recent);

    // Delete sessions older than 1 day
    const deleted = await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 });
    expect(deleted).toBe(1);

    expect(await store.exists('old-session')).toBe(false);
    expect(await store.exists('recent-session')).toBe(true);
  });

  it('cleanup removes many expired sessions with one aggregate index mutation', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    for (let index = 0; index < 20; index += 1) {
      await seedStoredSession(
        rawStore,
        makeSession({
          id: `expired-${index}`,
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
      );
    }
    let conditionalBatchCalls = 0;
    const instrumentedStore = {
      ...rawStore,
      conditionalBatch: async (
        conditions: Parameters<typeof rawStore.conditionalBatch>[0],
        operations: Parameters<typeof rawStore.conditionalBatch>[1],
      ) => {
        conditionalBatchCalls += 1;
        return rawStore.conditionalBatch(conditions, operations);
      },
    };
    const store = createSessionStore(instrumentedStore);

    expect(await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 })).toBe(20);
    expect(conditionalBatchCalls).toBe(1);
    expect(await store.list({ limit: 100 })).toEqual([]);
  });

  it('cleanup retains a logical session when either body representation is fresh', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const id = 'dual';
    const fresh = makeSession({ id, updatedAt: new Date().toISOString() });
    const expired = makeSession({ id, updatedAt: '2024-01-01T00:00:00.000Z' });
    await store.save(fresh);
    await rawStore.set(`agent-session:${id}`, JSON.stringify(expired));

    expect(await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 })).toBe(0);
    const loaded = await store.load(id);
    const summaries = await store.list({ limit: 10 });
    expect(loaded?.updatedAt).toBe(fresh.updatedAt);
    expect(summaries.map((summary) => summary.id)).toEqual([id]);
  });

  it('cleanup filters dual bodies using the canonical v2 agent name', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const id = 'dual-agent';
    const canonical = makeSession({
      id,
      agentName: 'canonical-agent',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const legacy = makeSession({
      id,
      agentName: 'legacy-agent',
      updatedAt: '2024-02-01T00:00:00.000Z',
    });
    await store.save(canonical);
    await rawStore.set(`agent-session:${id}`, JSON.stringify(legacy));

    expect(await store.cleanup({ olderThan: 24 * 60 * 60 * 1000, agentName: 'legacy-agent' })).toBe(
      0,
    );
    expect(await store.exists(id)).toBe(true);
  });

  it('cleanup filters by agentName', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);

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

    await seedStoredSession(rawStore, oldA);
    await seedStoredSession(rawStore, oldB);

    const deleted = await store.cleanup({
      olderThan: 24 * 60 * 60 * 1000,
      agentName: 'agent-a',
    });
    expect(deleted).toBe(1);

    expect(await store.exists('old-a')).toBe(false);
    expect(await store.exists('old-b')).toBe(true);
  });

  it('does not delete a different body when an embedded id mismatches its key', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const embedded = makeSession({
      id: 'embedded-session',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    await rawStore.set('agent-session:enumerated-session', JSON.stringify(embedded));

    expect(await store.cleanup({ olderThan: 24 * 60 * 60 * 1000 })).toBe(0);
    expect(await rawStore.has('agent-session:enumerated-session')).toBe(true);
    expect(await rawStore.has('agent-session:embedded-session')).toBe(false);
  });

  it('stores bodies under the session prefix and summaries in the aggregate index', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const session = makeSession({ id: 'prefix-test' });

    await store.save(session);

    const keys = await kv.list('agent-session:');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('agent-session:'))).toBe(true);
    expect(await kv.has(SUMMARY_INDEX_KEY)).toBe(true);
  });

  it('supports a session id that matches the reserved index suffix', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const ordinarySession = makeSession({ id: 'ordinary-session' });
    const session = makeSession({ id: 'summary-index' });

    await store.save(ordinarySession);
    expect(await store.exists(session.id)).toBe(false);
    await store.save(session);

    expect(await store.load(session.id)).toBeDefined();
    const summaries = await store.list({ limit: 10 });
    expect(summaries.map((summary) => summary.id)).toContain(session.id);
    await store.delete(session.id);
    expect(await store.load(session.id)).toBeUndefined();
    expect(await store.load(ordinarySession.id)).toBeDefined();
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(true);
  });

  it('list returns correct messageCount from conversation history', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
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
