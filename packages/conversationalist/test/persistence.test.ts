import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import type { ConversationEnvironment, SessionInfo } from '../src/environment';
import { toSessionInfo } from '../src/environment';
import { Conversation } from '../src/history';
import { createTestConversationEnvironment } from '../src/test/index';
import type { ConversationHistory } from '../src/types';

/** In-memory text-value store for tests, backed by Weft's MemoryStorage. */
const createMockKeyValueStore = () => textValueStore(new MemoryStorage());

async function saveConversation(
  store: ReturnType<typeof createMockKeyValueStore>,
  conversation: ConversationHistory,
): Promise<void> {
  await store.set(`session:${conversation.id}`, JSON.stringify(conversation));
  await store.set(`session-info:${conversation.id}`, JSON.stringify(toSessionInfo(conversation)));
}

async function loadConversation(
  store: ReturnType<typeof createMockKeyValueStore>,
  id: string,
): Promise<ConversationHistory | undefined> {
  const raw = await store.get(`session:${id}`);
  if (!raw) return undefined;
  return JSON.parse(raw) as ConversationHistory;
}

async function listSessionInfos(
  store: ReturnType<typeof createMockKeyValueStore>,
): Promise<SessionInfo[]> {
  const keys = await store.list('session-info:');
  const infos: SessionInfo[] = [];
  for (const key of keys) {
    const raw = await store.get(key);
    if (raw) {
      infos.push(JSON.parse(raw) as SessionInfo);
    }
  }
  return infos;
}

function createManualPersistenceTimer() {
  const timerHandlers: Array<() => Promise<void> | void> = [];
  type ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  type ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
  const scheduleTimeoutFunctionKey: ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  const clearTimeoutFunctionKey: ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
  const environment: Partial<ConversationEnvironment> = {
    [scheduleTimeoutFunctionKey]: (handler) => {
      timerHandlers.push(handler);
      return timerHandlers.length;
    },
    [clearTimeoutFunctionKey]: () => {},
  };
  return {
    environment,
    async flush(): Promise<void> {
      await timerHandlers.shift()?.();
      await Promise.resolve();
    },
  };
}

async function deleteConversation(
  store: ReturnType<typeof createMockKeyValueStore>,
  id: string,
): Promise<void> {
  await store.delete(`session:${id}`);
  await store.delete(`session-info:${id}`);
}

describe('KeyValueStore-based conversation persistence', () => {
  it('saves and loads a conversation round-trip', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ title: 'Test' }, environment);

    await saveConversation(store, conversation);
    const loaded = await loadConversation(store, conversation.id);

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(conversation.id);
    expect(loaded!.title).toBe('Test');
  });

  it('returns undefined for a nonexistent session', async () => {
    const store = createMockKeyValueStore();
    const loaded = await loadConversation(store, 'nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('lists SessionInfo for all saved conversations', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();

    const first = createConversationHistory({ id: 'session-1', title: 'First' }, environment);
    const second = createConversationHistory({ id: 'session-2', title: 'Second' }, environment);

    await saveConversation(store, first);
    await saveConversation(store, second);

    const sessions = await listSessionInfos(store);
    expect(sessions).toHaveLength(2);

    const ids = sessions.map((session) => session.id);
    expect(ids).toContain('session-1');
    expect(ids).toContain('session-2');
  });

  it('deletes both session and session-info keys', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'to-delete' }, environment);

    await saveConversation(store, conversation);
    expect(await loadConversation(store, 'to-delete')).toBeDefined();

    await deleteConversation(store, 'to-delete');
    expect(await loadConversation(store, 'to-delete')).toBeUndefined();

    const sessions = await listSessionInfos(store);
    expect(sessions).toHaveLength(0);
  });

  it('overwrites an existing session on save', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const original = createConversationHistory({ id: 'overwrite', title: 'Original' }, environment);
    const updated = { ...original, title: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' };

    await saveConversation(store, original);
    await saveConversation(store, updated);

    const loaded = await loadConversation(store, 'overwrite');
    expect(loaded!.title).toBe('Updated');
  });

  it('populates SessionInfo fields correctly including tags and messageCount', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'info-test', title: 'Info Test' }, environment),
      environment,
    );
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi');
    conversation.tag('important');

    await saveConversation(store, conversation.current);

    const sessions = await listSessionInfos(store);
    expect(sessions).toHaveLength(1);

    const session = sessions[0]!;
    expect(session.id).toBe('info-test');
    expect(session.title).toBe('Info Test');
    expect(session.tags).toEqual(['important']);
    expect(session.messageCount).toBe(2);
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });
});

describe('Conversation auto-persistence via KeyValueStore', () => {
  it('auto-saves when persistence is configured and a change event fires', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const persistenceTimer = createManualPersistenceTimer();
    const conversation = new Conversation(
      createConversationHistory({ id: 'auto-save' }, environment),
      { ...environment, ...persistenceTimer.environment, persistence: store },
    );

    conversation.appendUserMessage('Auto-saved message');

    await persistenceTimer.flush();

    const loaded = await loadConversation(store, 'auto-save');
    expect(loaded).toBeDefined();
    expect(loaded!.ids).toHaveLength(1);
  });

  it('auto-saves through the default debounce timer when no timer override is configured', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'auto-save-default-timer' }, environment),
      {
        ...environment,
        persistence: store,
        persistenceDebounceMilliseconds: 0,
      },
    );

    conversation.appendUserMessage('Auto-saved with default timer');
    conversation.appendAssistantMessage('Default timer debounce reset');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const loaded = await loadConversation(store, 'auto-save-default-timer');
    expect(loaded).toBeDefined();
    expect(loaded!.ids).toHaveLength(2);
  });

  it('auto-saves on tag changes', async () => {
    const store = createMockKeyValueStore();
    const environment = createTestConversationEnvironment();
    const persistenceTimer = createManualPersistenceTimer();
    const conversation = new Conversation(
      createConversationHistory({ id: 'auto-tag' }, environment),
      { ...environment, ...persistenceTimer.environment, persistence: store },
    );

    conversation.tag('auto-tagged');

    await persistenceTimer.flush();

    const loaded = await loadConversation(store, 'auto-tag');
    expect(loaded).toBeDefined();
    const tags = loaded!.metadata['_tags'] as string[];
    expect(tags).toEqual(['auto-tagged']);
  });
});
