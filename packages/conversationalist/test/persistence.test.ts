import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import type { SessionPersistenceAdapter } from '../src/environment';
import { Conversation } from '../src/history';
import { JsonlSessionPersistenceAdapter } from '../src/persistence/index';
import { createTestConversationEnvironment } from '../src/test/index';

describe('SessionPersistenceAdapter interface', () => {
  it('has a conformant in-memory implementation', async () => {
    const store = new Map<string, string>();
    const adapter: SessionPersistenceAdapter = {
      async save(conversation) {
        store.set(conversation.id, JSON.stringify(conversation));
      },
      async load(id) {
        const data = store.get(id);
        return data ? JSON.parse(data) : undefined;
      },
      async list() {
        return [...store.values()].map((raw) => {
          const conversation = JSON.parse(raw);
          return {
            id: conversation.id,
            title: conversation.title,
            tags: (conversation.metadata?._tags as string[]) ?? [],
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            messageCount: conversation.ids?.length ?? 0,
          };
        });
      },
      async delete(id) {
        store.delete(id);
      },
    };

    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ title: 'Test' }, environment);

    await adapter.save(conversation);
    const loaded = await adapter.load(conversation.id);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(conversation.id);
    expect(loaded!.title).toBe('Test');

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(conversation.id);
    expect(sessions[0].title).toBe('Test');
    expect(sessions[0].messageCount).toBe(0);

    await adapter.delete(conversation.id);
    const afterDelete = await adapter.load(conversation.id);
    expect(afterDelete).toBeUndefined();
  });
});

describe('JsonlSessionPersistenceAdapter', () => {
  let directory: string;
  let adapter: JsonlSessionPersistenceAdapter;

  beforeEach(() => {
    directory = join(tmpdir(), `conversationalist-test-${crypto.randomUUID()}`);
    adapter = new JsonlSessionPersistenceAdapter(directory);
  });

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('saves and loads a conversation', async () => {
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'session-1', title: 'Test' }, environment);

    await adapter.save(conversation);
    const loaded = await adapter.load('session-1');

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('session-1');
    expect(loaded!.title).toBe('Test');
    expect(loaded!.schemaVersion).toBe(conversation.schemaVersion);
  });

  it('returns undefined for a nonexistent session', async () => {
    const loaded = await adapter.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('lists all saved sessions', async () => {
    const environment = createTestConversationEnvironment();

    const first = createConversationHistory({ id: 'session-1', title: 'First' }, environment);
    const second = createConversationHistory({ id: 'session-2', title: 'Second' }, environment);

    await adapter.save(first);
    await adapter.save(second);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(2);

    const ids = sessions.map((session) => session.id);
    expect(ids).toContain('session-1');
    expect(ids).toContain('session-2');
  });

  it('returns an empty list when no sessions exist', async () => {
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(0);
  });

  it('deletes a session', async () => {
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'to-delete' }, environment);

    await adapter.save(conversation);
    expect(await adapter.load('to-delete')).toBeDefined();

    await adapter.delete('to-delete');
    expect(await adapter.load('to-delete')).toBeUndefined();
  });

  it('does not throw when deleting a nonexistent session', async () => {
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('overwrites an existing session on save', async () => {
    const environment = createTestConversationEnvironment();
    const original = createConversationHistory({ id: 'overwrite', title: 'Original' }, environment);
    const updated = { ...original, title: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' };

    await adapter.save(original);
    await adapter.save(updated);

    const loaded = await adapter.load('overwrite');
    expect(loaded!.title).toBe('Updated');
  });

  it('populates SessionInfo fields correctly including tags and messageCount', async () => {
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'info-test', title: 'Info Test' }, environment),
      environment,
    );
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi');
    conversation.tag('important');

    await adapter.save(conversation.current);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);

    const session = sessions[0];
    expect(session.id).toBe('info-test');
    expect(session.title).toBe('Info Test');
    expect(session.tags).toEqual(['important']);
    expect(session.messageCount).toBe(2);
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });

  it('creates the directory if it does not exist', async () => {
    const nested = join(directory, 'deeply', 'nested', 'path');
    const nestedAdapter = new JsonlSessionPersistenceAdapter(nested);
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'nested-test' }, environment);

    await nestedAdapter.save(conversation);

    expect(existsSync(nested)).toBe(true);
    const loaded = await nestedAdapter.load('nested-test');
    expect(loaded).toBeDefined();
  });
});

describe('Conversation auto-persistence', () => {
  let directory: string;

  beforeEach(() => {
    directory = join(tmpdir(), `conversationalist-test-${crypto.randomUUID()}`);
  });

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('auto-saves when persistence is configured and a change event fires', async () => {
    const adapter = new JsonlSessionPersistenceAdapter(directory);
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'auto-save' }, environment),
      { ...environment, persistence: adapter },
    );

    conversation.appendUserMessage('Auto-saved message');

    await Bun.sleep(50);

    const loaded = await adapter.load('auto-save');
    expect(loaded).toBeDefined();
    expect(loaded!.ids).toHaveLength(1);
  });

  it('auto-saves on tag changes', async () => {
    const adapter = new JsonlSessionPersistenceAdapter(directory);
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ id: 'auto-tag' }, environment),
      { ...environment, persistence: adapter },
    );

    conversation.tag('auto-tagged');

    await Bun.sleep(50);

    const loaded = await adapter.load('auto-tag');
    expect(loaded).toBeDefined();
    const tags = loaded!.metadata['_tags'] as string[];
    expect(tags).toEqual(['auto-tagged']);
  });
});
