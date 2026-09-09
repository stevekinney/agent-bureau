import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { createManualRuntimeServices } from 'lifecycle';

import { createAgentSession } from '../agent-session';
import { SessionOutboxAppendedEvent } from '../events';
import type { JSONValue } from '../types';
import {
  createSessionStore,
  SessionConflictError,
  StaleSessionIncarnationError,
} from './create-session-store';
import type { SessionOutboxEntry, SessionStore } from './types';

const SUMMARY_INDEX_KEY = 'agent-session:summary-index';
const BODY_PREFIX = 'agent-session-v2:body:';

// AB-390 — `acknowledge()` now requires the caller to hold the entry's
// claim. Every pre-existing outbox test in this file exercised
// `acknowledge()` directly, with no claim workflow of its own to model —
// this helper claims (as a single fixed test owner, which every test here
// is free to treat as "this test's only drainer") immediately before
// acknowledging, so those tests keep verifying what they always verified
// without each one re-deriving the claim-then-acknowledge sequence.
const TEST_OUTBOX_OWNER = 'test-drainer';
async function claimAndAcknowledge(store: SessionStore, ordinal: number): Promise<void> {
  const attempt = await store.outbox.claim(ordinal, {
    owner: TEST_OUTBOX_OWNER,
    until: Number.MAX_SAFE_INTEGER,
  });
  if (!attempt.claimed) {
    throw new Error(`expected to claim outbox entry ${ordinal} for test setup`);
  }
  const acknowledged = await store.outbox.acknowledge(ordinal, TEST_OUTBOX_OWNER);
  if (!acknowledged) {
    throw new Error(`expected to acknowledge outbox entry ${ordinal} after claiming it`);
  }
}

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

  it('preserves updatedAt when update() is called with refreshActivity: false', async () => {
    const runtime = createManualRuntimeServices({ origin: '2024-01-03T00:00:00.000Z' });
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    const session = makeSession({
      id: 'no-refresh-session',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    await store.save(session);
    const savedUpdatedAt = (await store.load(session.id))!.updatedAt;

    // Advance the manual clock so a refreshing write WOULD read back
    // differently — proving this update genuinely skipped the refresh
    // rather than merely landing at the same instant.
    await runtime.advance(60_000);

    await store.update(
      session.id,
      (current) => (current ? { ...current, agentName: 'renamed-agent' } : undefined),
      { refreshActivity: false },
    );

    const loaded = await store.load(session.id);
    expect(loaded!.agentName).toBe('renamed-agent');
    expect(loaded!.updatedAt).toBe(savedUpdatedAt);
  });

  it('still refreshes updatedAt on a default update() call (refreshActivity defaults to true)', async () => {
    const runtime = createManualRuntimeServices({ origin: '2024-01-03T00:00:00.000Z' });
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    const session = makeSession({
      id: 'default-refresh-session',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    await store.save(session);
    const savedUpdatedAt = (await store.load(session.id))!.updatedAt;

    await runtime.advance(60_000);

    await store.update(session.id, (current) =>
      current ? { ...current, agentName: 'renamed-agent' } : undefined,
    );

    const loaded = await store.load(session.id);
    expect(loaded!.updatedAt).not.toBe(savedUpdatedAt);
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

  it('delete removes a session and resolves true', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({});

    await store.save(session);
    expect(await store.load(session.id)).toBeDefined();

    expect(await store.delete(session.id)).toBe(true);
    expect(await store.load(session.id)).toBeUndefined();
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(false);
  });

  it('delete resolves false and is a no-op for a nonexistent session', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    expect(await store.delete('nonexistent')).toBe(false);
  });

  it('delete(id, { returnIncarnation: true }) reports removed and the incarnation of the exact body it removed (AB-384)', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'delete-incarnation' });

    await store.save(session);
    const incarnation = (await store.load(session.id))!.incarnation;
    expect(incarnation).not.toBe('');

    const result = await store.delete(session.id, { returnIncarnation: true });
    expect(result).toEqual({ removed: true, incarnation });
    expect(await store.load(session.id)).toBeUndefined();
  });

  it('delete(id, { returnIncarnation: true }) reports removed: false and incarnation: undefined for a nonexistent session', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    expect(await store.delete('nonexistent', { returnIncarnation: true })).toEqual({
      removed: false,
      incarnation: undefined,
    });
  });

  it('delete(id, { returnIncarnation: true }) never races a load() beforehand: a delete-then-recreate between load and delete cannot happen since there is no load', async () => {
    // The correctness this overload buys over "load(id) then delete(id)":
    // the incarnation reported is derived from the SAME CAS attempt that
    // performed the delete, never a separately-timed read.
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'delete-incarnation-recreate' });
    await store.save(session);
    const firstIncarnation = (await store.load(session.id))!.incarnation;
    await store.delete(session.id);
    await store.save(makeSession({ id: session.id }));
    const secondIncarnation = (await store.load(session.id))!.incarnation;
    expect(secondIncarnation).not.toBe(firstIncarnation);

    const result = await store.delete(session.id, { returnIncarnation: true });
    expect(result).toEqual({ removed: true, incarnation: secondIncarnation });
  });

  it('delete resolves false for a session already removed by a prior call', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({});
    await store.save(session);

    expect(await store.delete(session.id)).toBe(true);
    expect(await store.delete(session.id)).toBe(false);
  });

  it('delete cleans up an orphan summary when the session body is missing, resolving false', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await rawStore.set(SUMMARY_INDEX_KEY, summaryIndexPayload('orphan-session'));

    expect(await store.delete('orphan-session')).toBe(false);

    expect(await rawStore.has('agent-session:orphan-session')).toBe(false);
    expect(await rawStore.has(SUMMARY_INDEX_KEY)).toBe(false);
  });

  it('delete resolves true when only the legacy body key holds the record', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({});
    await seedStoredSession(rawStore, session);

    expect(await store.delete(session.id)).toBe(true);
    expect(await rawStore.has(`agent-session:${session.id}`)).toBe(false);
  });

  it('delete resolves true exactly once when two concurrent calls race for the same session', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const session = makeSession({});
    await store.save(session);

    const [first, second] = await Promise.all([store.delete(session.id), store.delete(session.id)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await store.load(session.id)).toBeUndefined();
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
        // Distinct, ordered timestamps only — the assertion below is about
        // pagination, not wall-clock time, so a fixed literal per index is
        // sufficient and avoids a real-clock read.
        updatedAt: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
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
    // AB-330: share one manual runtime between the store's cleanup cutoff and
    // the "recent" session's timestamp so both read the same deterministic
    // clock instead of the real one. Origin sits after `old`'s timestamp so
    // the cutoff (now - 1 day) falls after it too.
    const runtime = createManualRuntimeServices({ origin: '2024-01-03T00:00:00.000Z' });
    const store = createSessionStore(rawStore, { runtime });

    const old = makeSession({
      id: 'old-session',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const recent = makeSession({
      id: 'recent-session',
      updatedAt: runtime.clock.nowISO(),
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
    // AB-330: share one manual runtime between the store's cleanup cutoff and
    // the fresh session's timestamp so both read the same deterministic
    // clock instead of the real one. Origin sits after `expired`'s timestamp
    // so the cutoff (now - 1 day) falls after it too.
    const runtime = createManualRuntimeServices({ origin: '2024-01-03T00:00:00.000Z' });
    const store = createSessionStore(rawStore, { runtime });
    const id = 'dual';
    const fresh = makeSession({ id, updatedAt: runtime.clock.nowISO() });
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

describe('AgentSession.incarnation (AB-384)', () => {
  it('rejects (throws) rather than persisting an empty incarnation minted by a misbehaving RuntimeIdentifiers implementation (Codex P2 review finding, PR #592, "Reject empty incarnation IDs")', async () => {
    // `RuntimeIdentifiers.next`'s own contract permits any string,
    // including ''. Nothing enforces "nonempty" upstream, so the store
    // itself must fail loudly rather than silently persist the exact
    // sentinel `AgentSession.incarnation` reserves for "never minted".
    const runtime = createManualRuntimeServices();
    const faultyRuntime = {
      ...runtime,
      identifiers: { next: () => '' },
    };
    const store = createSessionStore(textValueStore(new MemoryStorage()), {
      runtime: faultyRuntime,
    });

    expect(store.save(makeSession({ id: 'empty-incarnation' }))).rejects.toThrow(
      /must never return ''/,
    );
  });

  it('mints an incarnation on the first save and keeps it stable across later save() and update() calls', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'incarnation-stability' });

    await store.save(session);
    const afterFirstSave = await store.load(session.id);
    expect(afterFirstSave!.incarnation).not.toBe('');

    await store.save({ ...afterFirstSave!, updatedAt: afterFirstSave!.updatedAt });
    const afterSecondSave = await store.load(session.id);
    expect(afterSecondSave!.incarnation).toBe(afterFirstSave!.incarnation);

    await store.update(session.id, (current) => current);
    const afterUpdate = await store.load(session.id);
    expect(afterUpdate!.incarnation).toBe(afterFirstSave!.incarnation);
  });

  it('mints a fresh incarnation when a deleted id is recreated', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'incarnation-recreate' });

    await store.save(session);
    const firstIncarnation = (await store.load(session.id))!.incarnation;

    expect(await store.delete(session.id)).toBe(true);

    await store.save(makeSession({ id: session.id }));
    const secondIncarnation = (await store.load(session.id))!.incarnation;

    expect(secondIncarnation).not.toBe('');
    expect(secondIncarnation).not.toBe(firstIncarnation);
  });

  it('mints a fresh incarnation for a legacy record with no incarnation field, without treating the write as a creation', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    const legacySession = makeSession({ id: 'legacy-incarnation' });
    const { incarnation: _incarnation, ...legacyPayload } = legacySession;
    await rawStore.set('agent-session:legacy-incarnation', JSON.stringify(legacyPayload));

    const loaded = await store.load('legacy-incarnation');
    expect(loaded!.incarnation).toBe('');

    await store.save({ ...loaded!, updatedAt: loaded!.updatedAt });

    const persisted = await store.load('legacy-incarnation');
    expect(persisted!.incarnation).not.toBe('');
    // AB-389 — the outbox entry, not a directly-dispatched event, is the
    // durable fact now: this write commits against an EXISTING live body
    // (the legacy record `load()` just upgraded), so it is a
    // `'session.saved'` entry, never `'session.created'`.
    const pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.saved');
    expect(pending[0]?.incarnation).toBe(persisted!.incarnation);
  });

  it('rejects save() of a candidate naming a specific prior incarnation that no longer matches the live body (Codex P1 review finding, PR #592)', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-incarnation-save' });

    await store.save(session);
    const staleWriter = (await store.load(session.id))!;

    expect(await store.delete(session.id)).toBe(true);
    await store.save(makeSession({ id: session.id }));
    const recreated = (await store.load(session.id))!;
    expect(recreated.incarnation).not.toBe(staleWriter.incarnation);

    // `staleWriter` still names its own (now-deleted) incarnation — writing
    // it back must fail rather than silently relabel its stale content
    // under the RECREATED session's current incarnation.
    expect(store.save(staleWriter)).rejects.toThrow(StaleSessionIncarnationError);
    // The recreated session's live body is untouched by the rejected write.
    expect((await store.load(session.id))!.incarnation).toBe(recreated.incarnation);
  });

  it('rejects update() when the updater returns a candidate naming a specific prior incarnation that no longer matches the live body (Codex P1 review finding, PR #592)', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'stale-incarnation-update' });

    await store.save(session);
    const staleWriter = (await store.load(session.id))!;

    expect(await store.delete(session.id)).toBe(true);
    await store.save(makeSession({ id: session.id }));

    expect(store.update(session.id, () => staleWriter)).rejects.toThrow(
      StaleSessionIncarnationError,
    );
  });

  it('never rejects a candidate with incarnation "" (the createAgentSession() default), even against a live body that already has one', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'unminted-incarnation-write' });
    await store.save(session);
    const loaded = (await store.load(session.id))!;
    expect(loaded.incarnation).not.toBe('');

    // A fresh, never-saved AgentSession object (incarnation: '') merged onto
    // the same id must not be treated as a stale-incarnation conflict.
    await store.save({ ...makeSession({ id: session.id }), revision: loaded.revision });
    expect((await store.load(session.id))!.incarnation).toBe(loaded.incarnation);
  });
});

describe('SessionStore commit outbox (AB-389)', () => {
  it('appends a session.created outbox entry on the first save() and a session.saved entry on the next one, both carrying the same incarnation', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'events-save', agentName: 'events-agent' });

    const triggers: SessionOutboxAppendedEvent[] = [];
    store.events.addEventListener(SessionOutboxAppendedEvent.type, (event) => triggers.push(event));

    await store.save(session);
    let pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    const firstEntry = pending[0];
    if (firstEntry?.kind !== 'session.created') {
      throw new Error('expected a session.created outbox entry');
    }
    expect(firstEntry.sessionId).toBe('events-save');
    expect(firstEntry.agentName).toBe('events-agent');
    expect(firstEntry.incarnation).not.toBe('');
    expect(firstEntry.ordinal).toBe(1);
    // The best-effort drain trigger fires once per appended entry, naming
    // that entry's own ordinal.
    expect(triggers.map((event) => event.ordinal)).toEqual([1]);
    await claimAndAcknowledge(store, pending[0]!.ordinal);

    const firstIncarnation = pending[0]!.incarnation;
    const reloaded = await store.load(session.id);
    await store.save({ ...reloaded!, updatedAt: reloaded!.updatedAt });
    pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.saved');
    expect(pending[0]?.incarnation).toBe(firstIncarnation);
    expect(pending[0]?.ordinal).toBe(2);
    expect(triggers.map((event) => event.ordinal)).toEqual([1, 2]);
  });

  it('appends a session.created entry when update() creates a brand-new session and a session.saved entry on the next update()', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));

    await store.update(
      'events-update',
      (existing) => existing ?? makeSession({ id: 'events-update' }),
    );
    let pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.created');
    const firstIncarnation = pending[0]!.incarnation;
    await claimAndAcknowledge(store, pending[0]!.ordinal);

    await store.update('events-update', (existing) => existing);
    pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.saved');
    expect(pending[0]?.incarnation).toBe(firstIncarnation);
  });

  it('appends a fresh session.created entry, with a new incarnation, when a deleted id is recreated — and a session.deleted entry for the removal in between', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const session = makeSession({ id: 'events-recreate' });

    await store.save(session);
    let pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    const firstIncarnation = pending[0]!.incarnation;
    await claimAndAcknowledge(store, pending[0]!.ordinal);

    expect(await store.delete(session.id)).toBe(true);
    pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.deleted');
    expect(pending[0]?.incarnation).toBe(firstIncarnation);
    await claimAndAcknowledge(store, pending[0]!.ordinal);

    await store.save(makeSession({ id: session.id }));
    pending = await store.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('session.created');
    expect(pending[0]?.incarnation).not.toBe(firstIncarnation);
  });

  it('does not append an outbox entry, or consume an ordinal, for a delete() that removes nothing', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    expect(await store.delete('never-existed')).toBe(false);
    expect(await store.outbox.pending()).toHaveLength(0);

    // The ordinal counter is untouched: the next real commit still starts at 1.
    await store.save(makeSession({ id: 'after-noop-delete' }));
    const pending = await store.outbox.pending();
    expect(pending[0]?.ordinal).toBe(1);
  });

  it('lists pending entries oldest-ordinal-first regardless of insertion order across sessions', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(makeSession({ id: 'ordinal-a' }));
    await store.save(makeSession({ id: 'ordinal-b' }));
    await store.save(makeSession({ id: 'ordinal-c' }));

    const pending = await store.outbox.pending();
    expect(pending.map((entry) => entry.sessionId)).toEqual([
      'ordinal-a',
      'ordinal-b',
      'ordinal-c',
    ]);
    expect(pending.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
  });

  it('acknowledge() is idempotent — acknowledging an already-removed entry is a silent no-op that resolves true', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(makeSession({ id: 'ack-twice' }));
    const [entry] = await store.outbox.pending();
    await claimAndAcknowledge(store, entry!.ordinal);
    expect(await store.outbox.pending()).toHaveLength(0);
    // Second acknowledge of the same, now-gone ordinal must not throw, and
    // must resolve `true` — the entry is gone either way, exactly what a
    // caller checking "is this retired now" wants to see.
    expect(await store.outbox.acknowledge(entry!.ordinal, TEST_OUTBOX_OWNER)).toBe(true);
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('fails loudly, rather than silently resetting to 0 and reusing ordinals, when the outbox ordinal counter itself is corrupted (Codex/Copilot review finding)', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await store.save(makeSession({ id: 'corrupted-ordinal-seed' }));
    const [seedEntry] = await store.outbox.pending();
    await claimAndAcknowledge(store, seedEntry!.ordinal);

    // Corrupt the counter directly — not a value any commit here ever writes.
    await rawStore.set('agent-session-outbox:v1:ordinal', 'not-a-number');

    expect(store.save(makeSession({ id: 'corrupted-ordinal-next' }))).rejects.toThrow(
      /outbox ordinal counter is corrupted/,
    );
  });

  it('fails loudly, rather than silently treating it as absent, when a stored outbox entry is malformed (Codex P2 review finding, PR #598)', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await store.save(makeSession({ id: 'malformed-entry' }));
    const [entry] = await store.outbox.pending();

    // Overwrite the entry's own stored value with something that parses as
    // JSON but is missing a required field — not a value any commit here
    // ever writes.
    await rawStore.set(
      `agent-session-outbox:v1:entry:${String(entry!.ordinal).padStart(20, '0')}`,
      JSON.stringify({ ordinal: entry!.ordinal, kind: 'session.created', sessionId: 'x' }),
    );

    expect(store.outbox.pending()).rejects.toThrow(/outbox entry is corrupted/);
  });

  it('rejects a caller-supplied SessionStore contract where a discriminated-union outbox entry requires agentName for created/saved kinds (AB-389)', async () => {
    // Type-level regression only: `SessionOutboxEntry` must not permit a
    // 'session.created'/'session.saved' entry with a missing `agentName` —
    // Codex P2 review finding, PR #598, "Require agent names on created and
    // saved entries". This assignment would fail to compile if the union
    // regressed to the old shape with an optional `agentName`.
    const entry: SessionOutboxEntry = {
      ordinal: 1,
      kind: 'session.created',
      sessionId: 'typed-entry',
      agentName: 'typed-agent',
      incarnation: 'incarnation-a',
      committedAtMs: 0,
    };
    expect(entry.agentName).toBe('typed-agent');

    const deleted: SessionOutboxEntry = {
      ordinal: 2,
      kind: 'session.deleted',
      sessionId: 'typed-entry',
      incarnation: 'incarnation-a',
      committedAtMs: 0,
    };
    expect('agentName' in deleted).toBe(false);
  });

  it('persists the true commit time on each outbox entry, not the time a later drain happens to read it (AB-389)', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    const commitTime = runtime.clock.now();
    await store.save(makeSession({ id: 'commit-time' }));

    // Advance the clock well past the commit before a "drain" reads the
    // entry back — a delayed maintenance pass or a process restart is
    // exactly this scenario in production.
    await runtime.advance(60_000);
    const [entry] = await store.outbox.pending();
    expect(entry?.committedAtMs).toBe(commitTime);
    expect(entry?.committedAtMs).not.toBe(runtime.clock.now());
  });
});

describe('SessionStore outbox attachments (AB-391)', () => {
  it('appends a session.attachment entry, at the ordinal right after the primary entry, in the same update() commit', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.update(
      'attachment-session',
      (existing) => existing ?? makeSession({ id: 'attachment-session' }),
      {
        outbox: [
          {
            namespace: 'audit-record',
            payload: { runId: 'r1', type: 'review.tool-approval.approved' },
          },
        ],
      },
    );

    const pending = await store.outbox.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.kind).toBe('session.created');
    expect(pending[0]?.ordinal).toBe(1);
    const attachment = pending[1];
    if (attachment?.kind !== 'session.attachment') {
      throw new Error('expected a session.attachment outbox entry');
    }
    expect(attachment.ordinal).toBe(2);
    expect(attachment.sessionId).toBe('attachment-session');
    expect(attachment.namespace).toBe('audit-record');
    expect(attachment.payload).toEqual({ runId: 'r1', type: 'review.tool-approval.approved' });
    expect(attachment.committedAtMs).toBe(pending[0]!.committedAtMs);
  });

  it('appends multiple attachments at consecutive ordinals and advances the shared ordinal counter past all of them', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.update(
      'multi-attachment',
      (existing) => existing ?? makeSession({ id: 'multi-attachment' }),
      {
        outbox: [
          { namespace: 'audit-record', payload: { n: 1 } },
          { namespace: 'audit-record', payload: { n: 2 } },
        ],
      },
    );
    const pending = await store.outbox.pending();
    expect(pending.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);

    await store.save(makeSession({ id: 'after-multi-attachment' }));
    const nextPending = await store.outbox.pending();
    expect(nextPending.at(-1)?.ordinal).toBe(4);
  });

  it('appends no attachment entry when the updater declines to commit', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const result = await store.update('never-committed', () => undefined, {
      outbox: [{ namespace: 'audit-record', payload: { n: 1 } }],
    });
    expect(result).toBeUndefined();
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('fails loudly on a stored session.attachment entry missing its namespace or payload', async () => {
    const rawStore = textValueStore(new MemoryStorage());
    const store = createSessionStore(rawStore);
    await store.update(
      'malformed-attachment',
      (existing) => existing ?? makeSession({ id: 'malformed-attachment' }),
      { outbox: [{ namespace: 'audit-record', payload: { n: 1 } }] },
    );
    const [, attachment] = await store.outbox.pending();

    await rawStore.set(
      `agent-session-outbox:v1:entry:${String(attachment!.ordinal).padStart(20, '0')}`,
      JSON.stringify({
        ordinal: attachment!.ordinal,
        kind: 'session.attachment',
        sessionId: 'malformed-attachment',
        incarnation: 'x',
        committedAtMs: 0,
      }),
    );
    expect(store.outbox.pending()).rejects.toThrow(/expected a string "namespace"/);

    await rawStore.set(
      `agent-session-outbox:v1:entry:${String(attachment!.ordinal).padStart(20, '0')}`,
      JSON.stringify({
        ordinal: attachment!.ordinal,
        kind: 'session.attachment',
        sessionId: 'malformed-attachment',
        incarnation: 'x',
        namespace: 'audit-record',
        committedAtMs: 0,
      }),
    );
    expect(store.outbox.pending()).rejects.toThrow(/expected a "payload"/);
  });

  it('rejects update() synchronously when an outbox attachment has an undefined payload, before anything commits (Codex P2 review finding, PR #601, "Validate attachments before committing malformed outbox entries")', async () => {
    // An untyped caller (or a cast past `JSONValue`) can pass `payload:
    // undefined` — `JSON.stringify` would silently OMIT that key from the
    // committed entry, and every later `outbox.pending()` call would then
    // throw on it forever (the malformed-entry test above, but self-
    // inflicted at write time instead of injected by hand afterward).
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await expect(
      store.update(
        'undefined-payload-attachment',
        (existing) => existing ?? makeSession({ id: 'undefined-payload-attachment' }),
        {
          outbox: [{ namespace: 'audit-record', payload: undefined as unknown as JSONValue }],
        },
      ),
    ).rejects.toThrow(TypeError);

    // Nothing committed — not the session body, not the outbox ordinal.
    expect(await store.load('undefined-payload-attachment')).toBeUndefined();
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('rejects update() synchronously when an outbox attachment has an empty namespace', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await expect(
      store.update(
        'empty-namespace-attachment',
        (existing) => existing ?? makeSession({ id: 'empty-namespace-attachment' }),
        { outbox: [{ namespace: '', payload: { n: 1 } }] },
      ),
    ).rejects.toThrow(TypeError);
    expect(await store.load('empty-namespace-attachment')).toBeUndefined();
  });

  it('commits the ORIGINAL validated attachment payload even when the updater mutates the caller\'s own attachment object afterward (Codex P2 review finding, PR #601, "Snapshot attachments before invoking the updater")', async () => {
    // `options.outbox` is validated once, before the retry loop, against
    // the SAME objects the caller passed in. `updater` is caller code,
    // awaited inside that loop — it can mutate one of those same objects
    // (setting `payload` to `undefined`, say) after it passed validation
    // but before `commit()` serializes it. Without a snapshot, `commit()`
    // would durably write a `session.attachment` entry missing `payload`
    // entirely (`JSON.stringify` silently omits an `undefined` value),
    // permanently blocking every later `outbox.pending()` call on that
    // entry.
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const attachment: { namespace: string; payload: JSONValue } = {
      namespace: 'audit-record',
      payload: { original: true },
    };
    await store.update(
      'snapshot-attachment-session',
      (existing) => {
        // Mutate the caller-owned attachment object AFTER `update()`'s own
        // validation already ran against it, but BEFORE `commit()` below
        // serializes it.
        (attachment as { payload: unknown }).payload = undefined;
        return existing ?? makeSession({ id: 'snapshot-attachment-session' });
      },
      { outbox: [attachment] },
    );

    const pending = await store.outbox.pending();
    const entry = pending.find((candidate) => candidate.kind === 'session.attachment');
    if (entry?.kind !== 'session.attachment') {
      throw new Error('expected a session.attachment outbox entry');
    }
    // The committed entry carries the ORIGINAL validated payload, not the
    // mutated (now-`undefined`) one — and, critically, is still a valid
    // entry a later `outbox.pending()` call can parse without throwing.
    expect(entry.payload).toEqual({ original: true });
  });
});

describe('SessionStore outbox claim lease (AB-390)', () => {
  it('claims an unclaimed entry and refuses the same claim to a different owner while the lease is live', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-exclusive' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    const firstClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(firstClaim.claimed).toBe(true);
    // A different owner is refused while drainer-a's lease has not expired.
    const secondClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-b',
      until: runtime.clock.now() + 30_000,
    });
    expect(secondClaim.claimed).toBe(false);
  });

  it('allows the same owner to renew its own claim without waiting for expiry', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-renew' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    const initialClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 1_000,
    });
    expect(initialClaim.claimed).toBe(true);
    // Re-claiming as the SAME owner succeeds even though the prior lease
    // has not expired — renewal, not a conflict.
    const renewedClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(renewedClaim.claimed).toBe(true);
  });

  it("lets a different owner reclaim once the prior claim has expired by the store's own clock", async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-expired-reclaim' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    await store.outbox.claim(ordinal, {
      owner: 'crashed-drainer',
      until: runtime.clock.now() + 1_000,
    });
    await runtime.advance(1_001);
    const reclaim = await store.outbox.claim(ordinal, {
      owner: 'new-drainer',
      until: runtime.clock.now() + 30_000,
    });
    expect(reclaim.claimed).toBe(true);
  });

  it('returns false for claim() on an ordinal with no pending entry (already acknowledged)', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-gone' }));
    const [entry] = await store.outbox.pending();
    await claimAndAcknowledge(store, entry!.ordinal);
    const lateClaim = await store.outbox.claim(entry!.ordinal, {
      owner: 'late-drainer',
      until: runtime.clock.now() + 1_000,
    });
    expect(lateClaim.claimed).toBe(false);
  });

  it('acknowledge() refuses to remove an entry whose claim was reclaimed by a different owner', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'ack-lost-claim' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    await store.outbox.claim(ordinal, {
      owner: 'crashed-drainer',
      until: runtime.clock.now() + 1_000,
    });
    await runtime.advance(1_001);
    const reclaim = await store.outbox.claim(ordinal, {
      owner: 'reclaiming-drainer',
      until: runtime.clock.now() + 30_000,
    });
    expect(reclaim.claimed).toBe(true);

    // The original (now-lapsed) owner's own acknowledge must not retire an
    // entry a different owner has since reclaimed.
    expect(await store.outbox.acknowledge(ordinal, 'crashed-drainer')).toBe(false);
    expect(await store.outbox.pending()).toHaveLength(1);

    // The current claimant's acknowledge succeeds.
    expect(await store.outbox.acknowledge(ordinal, 'reclaiming-drainer')).toBe(true);
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('acknowledge() refuses an entry that was never claimed by the calling owner', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(makeSession({ id: 'ack-without-claim' }));
    const [entry] = await store.outbox.pending();
    expect(await store.outbox.acknowledge(entry!.ordinal, 'never-claimed-this')).toBe(false);
    expect(await store.outbox.pending()).toHaveLength(1);
  });

  it.each([NaN, Infinity, -Infinity])(
    'claim() rejects a non-finite lease.until (%p), rather than persisting a value JSON.stringify would silently turn into null (Codex P2 review finding, PR #599)',
    async (until) => {
      const runtime = createManualRuntimeServices();
      const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
      await store.save(makeSession({ id: `claim-non-finite-${until}` }));
      const [entry] = await store.outbox.pending();
      await expect(
        store.outbox.claim(entry!.ordinal, { owner: 'drainer-a', until }),
      ).rejects.toThrow(TypeError);
      // Rejected before any store mutation — the entry is still pending
      // and unclaimed, not wedged behind a corrupted `claim` field.
      expect(await store.outbox.pending()).toHaveLength(1);
      const claimAttempt = await store.outbox.claim(entry!.ordinal, {
        owner: 'drainer-a',
        until: runtime.clock.now() + 30_000,
      });
      expect(claimAttempt.claimed).toBe(true);
    },
  );

  it('claim() retries CAS contention for the SAME owner rather than reporting a false conflict (Codex P2 review finding, PR #599)', async () => {
    const runtime = createManualRuntimeServices();
    const base = textValueStore(new MemoryStorage());
    let conditionalBatchCalls = 0;
    // Stands in for two overlapping renewal calls racing the SAME CAS: the
    // first attempt loses (as if a concurrent call won it first) even
    // though nothing about the entry actually changed, so a correct retry
    // re-reads and wins on its next attempt rather than surfacing `false`.
    let contentionArmed = false;
    const contended = {
      ...base,
      async conditionalBatch(
        conditions: Parameters<typeof base.conditionalBatch>[0],
        operations: Parameters<typeof base.conditionalBatch>[1],
      ) {
        if (contentionArmed) {
          conditionalBatchCalls += 1;
          if (conditionalBatchCalls === 1) return false;
        }
        return base.conditionalBatch(conditions, operations);
      },
    };
    const store = createSessionStore(contended, { runtime });
    await store.save(makeSession({ id: 'claim-same-owner-retry' }));
    const [entry] = await store.outbox.pending();
    // Only the claim() call below is under test — `save()`'s own
    // conditionalBatch calls (appending the outbox entry itself) must not
    // count toward the retry assertion.
    contentionArmed = true;

    const claimAttempt = await store.outbox.claim(entry!.ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(claimAttempt.claimed).toBe(true);
    expect(conditionalBatchCalls).toBe(2);
  });

  it('claim() gives up and returns false after exhausting its retries against a different, still-live owner (never confused with same-owner contention)', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-different-owner-no-retry' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    const firstClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(firstClaim.claimed).toBe(true);
    const secondClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-b',
      until: runtime.clock.now() + 30_000,
    });
    expect(secondClaim.claimed).toBe(false);
  });

  it("acknowledge() reports true, not a false conflict, when a peer's own claim-and-acknowledge already retired the entry between this call's read and its CAS (Copilot review finding, PR #599)", async () => {
    const runtime = createManualRuntimeServices();
    const base = textValueStore(new MemoryStorage());
    let interceptedDelete = false;
    const store = createSessionStore(
      {
        ...base,
        async conditionalBatch(
          conditions: Parameters<typeof base.conditionalBatch>[0],
          operations: Parameters<typeof base.conditionalBatch>[1],
        ) {
          // Only `acknowledge()`'s own CAS issues a `delete` operation —
          // `save()`'s outbox append and `claim()`'s lease write both
          // issue `set` — so gating on the operation's own shape targets
          // exactly the call under test without an unrelated call-count
          // that would also have to account for `save()`'s own append.
          const deleteOperation = operations.find(
            (operation): operation is { type: 'delete'; key: string } =>
              operation.type === 'delete',
          );
          if (deleteOperation && !interceptedDelete) {
            interceptedDelete = true;
            // Simulates a peer's own claim-and-acknowledge landing between
            // this call's initial read and its own CAS: by the time this
            // call's CAS runs, the entry is already gone, so the CAS
            // legitimately loses — but the caller's OWN intent (retire
            // this entry) has still been satisfied.
            await base.delete(deleteOperation.key);
            return false;
          }
          return base.conditionalBatch(conditions, operations);
        },
      },
      { runtime },
    );
    await store.save(makeSession({ id: 'ack-peer-retired-race' }));
    const [entry] = await store.outbox.pending();
    const claimAttempt = await store.outbox.claim(entry!.ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(claimAttempt.claimed).toBe(true);

    expect(await store.outbox.acknowledge(entry!.ordinal, 'drainer-a')).toBe(true);
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('claim() never lets a same-owner renewal shorten an already-persisted longer lease (Codex P1 review finding, PR #599, "Prevent stale renewals from shortening the active lease")', async () => {
    const runtime = createManualRuntimeServices();
    const base = textValueStore(new MemoryStorage());
    const store = createSessionStore(base, { runtime });
    await store.save(makeSession({ id: 'claim-monotonic-renewal' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    const initialClaim = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 1_000,
    });
    expect(initialClaim.claimed).toBe(true);

    // Simulates a LATER renewal call (a fresh `now`, so a longer `until`)
    // already having persisted its own write — as if it won a race against
    // an earlier-computed renewal call that is only now (below) about to
    // run its own CAS.
    const laterRenewalUntil = runtime.clock.now() + 30_000;
    const laterRenewal = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: laterRenewalUntil,
    });
    expect(laterRenewal.claimed).toBe(true);

    // An EARLIER-computed renewal call (a smaller `until`, as if it had been
    // delayed and is only landing now) must not shorten the deadline the
    // later call already persisted — same-owner writes may only ever
    // EXTEND the stored lease.
    const earlierComputedUntil = runtime.clock.now() + 3_000;
    const earlierRenewal = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: earlierComputedUntil,
    });
    expect(earlierRenewal.claimed).toBe(true);

    const [afterBoth] = await store.outbox.pending();
    expect(afterBoth!.claim?.until).toBe(laterRenewalUntil);
  });

  it('claim() reports the current winning lease as fresh evidence when a different owner already holds it, not a bare false (Codex P1 review finding, PR #599, "Re-read the winning claim before deciding not to retry")', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-fresh-evidence' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;
    const holderUntil = runtime.clock.now() + 12_345;

    const holderClaim = await store.outbox.claim(ordinal, { owner: 'holder', until: holderUntil });
    expect(holderClaim.claimed).toBe(true);

    const attempt = await store.outbox.claim(ordinal, {
      owner: 'challenger',
      until: runtime.clock.now() + 30_000,
    });
    if (attempt.claimed) throw new Error('expected the challenger to be refused the claim');
    expect(attempt.lease).toEqual({ owner: 'holder', until: holderUntil });
  });

  it('claim() reports no lease when the entry no longer exists, distinguishing "gone" from "held by someone else"', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(makeSession({ id: 'claim-fresh-evidence-gone' }));
    const [entry] = await store.outbox.pending();
    await claimAndAcknowledge(store, entry!.ordinal);

    const attempt = await store.outbox.claim(entry!.ordinal, {
      owner: 'late-drainer',
      until: 1_000,
    });
    if (attempt.claimed) throw new Error('expected no entry left to claim');
    expect(attempt.lease).toBeUndefined();
  });

  it('acknowledge() retries the delete after losing its CAS to this SAME owner\'s own concurrent claim renewal (Codex P1 review finding, PR #599, "Retry acknowledge after a same-owner renewal wins the CAS")', async () => {
    const runtime = createManualRuntimeServices();
    const base = textValueStore(new MemoryStorage());
    let renewalWonRace = false;
    const store = createSessionStore(
      {
        ...base,
        async conditionalBatch(
          conditions: Parameters<typeof base.conditionalBatch>[0],
          operations: Parameters<typeof base.conditionalBatch>[1],
        ) {
          const deleteOperation = operations.find(
            (operation): operation is { type: 'delete'; key: string } =>
              operation.type === 'delete',
          );
          if (deleteOperation && !renewalWonRace) {
            renewalWonRace = true;
            // Simulates this SAME owner's periodic lease-renewal timer
            // (`create-bureau.ts`) winning a race between acknowledge()'s
            // read and its own delete CAS: the stored value changes (a
            // fresh claim write, still owned by "drainer-a"), so THIS
            // delete CAS legitimately loses even though the owner never
            // actually lost the claim.
            const raw = await base.get(deleteOperation.key);
            if (raw !== null) {
              const renewed = JSON.parse(raw) as Record<string, unknown>;
              renewed['claim'] = { owner: 'drainer-a', until: runtime.clock.now() + 60_000 };
              await base.set(deleteOperation.key, JSON.stringify(renewed));
            }
            return false;
          }
          return base.conditionalBatch(conditions, operations);
        },
      },
      { runtime },
    );
    await store.save(makeSession({ id: 'ack-retry-same-owner-renewal' }));
    const [entry] = await store.outbox.pending();
    const claimAttempt = await store.outbox.claim(entry!.ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(claimAttempt.claimed).toBe(true);

    // The delete's first CAS attempt loses to the simulated renewal above,
    // but the entry is still owned by "drainer-a" — acknowledge() must
    // retry rather than reporting a false conflict.
    expect(await store.outbox.acknowledge(entry!.ordinal, 'drainer-a')).toBe(true);
    expect(await store.outbox.pending()).toHaveLength(0);
  });

  it('claim() refuses to persist a lease that is already expired by the time it is about to write it — a slow store.get() must not report a false claimed:true (Codex P1 review finding, PR #599, "Refuse leases that expire before the claim is persisted")', async () => {
    const runtime = createManualRuntimeServices();
    const base = textValueStore(new MemoryStorage());
    // Armed only right before the `claim()` call under test below — `get()`
    // is also called by `pending()` above it, which must not consume this
    // one-shot delay.
    let armed = false;
    let delayed = false;
    const slowGet = {
      ...base,
      async get(key: string) {
        const value = await base.get(key);
        // Simulates `store.get()` itself taking long enough that the
        // clock has already passed the caller's requested `until` by the
        // time this attempt is ready to persist it — a slow backend, not
        // a caller bug.
        if (armed && key.includes('outbox') && !delayed) {
          delayed = true;
          await runtime.advance(10_000);
        }
        return value;
      },
    };
    const store = createSessionStore(slowGet, { runtime });
    await store.save(makeSession({ id: 'claim-expires-before-persist' }));
    const [entry] = await store.outbox.pending();

    // Requested lease is only 1s out — by the time the delayed `get()`
    // above returns, 10s have already passed.
    armed = true;
    const attempt = await store.outbox.claim(entry!.ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 1_000,
    });
    expect(attempt.claimed).toBe(false);

    // The entry is genuinely unclaimed — a fresh, still-valid lease
    // request succeeds normally.
    const retry = await store.outbox.claim(entry!.ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 30_000,
    });
    expect(retry.claimed).toBe(true);
  });

  it('claim() never persists a lease that is already expired even for a same-owner renewal request naming a stale absolute deadline', async () => {
    const runtime = createManualRuntimeServices();
    const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
    await store.save(makeSession({ id: 'claim-stale-renewal-deadline' }));
    const [entry] = await store.outbox.pending();
    const ordinal = entry!.ordinal;

    const initial = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() + 1_000,
    });
    expect(initial.claimed).toBe(true);

    // The prior claim expires; a caller then supplies a stale, already-past
    // absolute `until` (a caller bug, not a timing race) for the SAME
    // owner — same-owner reentry must not bypass the expiry check.
    await runtime.advance(2_000);
    const staleRenewal = await store.outbox.claim(ordinal, {
      owner: 'drainer-a',
      until: runtime.clock.now() - 500,
    });
    expect(staleRenewal.claimed).toBe(false);
  });
});
