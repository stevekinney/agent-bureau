import { describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import { Conversation } from '../src/history';
import { createInMemoryPersistenceAdapter } from '../src/persistence/in-memory-adapter';
import { createTestConversationEnvironment } from '../src/test/index';

describe('createInMemoryPersistenceAdapter', () => {
  it('saves and loads a conversation round-trip preserving all fields', async () => {
    const adapter = createInMemoryPersistenceAdapter();
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
    const adapter = createInMemoryPersistenceAdapter();
    const loaded = await adapter.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('lists correct SessionInfo entries', async () => {
    const adapter = createInMemoryPersistenceAdapter();
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
    const adapter = createInMemoryPersistenceAdapter();
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'to-delete' }, environment);

    await adapter.save(conversation);
    expect(await adapter.load('to-delete')).toBeDefined();

    await adapter.delete('to-delete');
    expect(await adapter.load('to-delete')).toBeUndefined();
  });

  it('does not throw when deleting a nonexistent entry', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('overwrites an existing entry on save', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const environment = createTestConversationEnvironment();
    const original = createConversationHistory({ id: 'overwrite', title: 'Original' }, environment);
    const updated = { ...original, title: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' };

    await adapter.save(original);
    await adapter.save(updated);

    const loaded = await adapter.load('overwrite');
    expect(loaded!.title).toBe('Updated');
  });

  it('deep-clones on save so external mutations do not affect stored data', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const environment = createTestConversationEnvironment();
    const mutableHistory = createConversationHistory(
      { id: 'clone-save', title: 'Before' },
      environment,
    );

    await adapter.save(mutableHistory);

    // Mutate the original object after saving
    (mutableHistory as { title: string }).title = 'Mutated';

    const loaded = await adapter.load('clone-save');
    expect(loaded!.title).toBe('Before');
  });

  it('deep-clones on load so mutations to loaded data do not affect stored data', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory(
      { id: 'clone-load', title: 'Stable' },
      environment,
    );

    await adapter.save(conversation);

    const loadedFirst = await adapter.load('clone-load');
    (loadedFirst as unknown as { title: string }).title = 'Tampered';

    const loadedSecond = await adapter.load('clone-load');
    expect(loadedSecond!.title).toBe('Stable');
  });

  it('accepts initialData option', async () => {
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory(
      { id: 'initial', title: 'Pre-loaded' },
      environment,
    );
    const initialData = new Map<string, typeof conversation>([[conversation.id, conversation]]);

    const adapter = createInMemoryPersistenceAdapter({ initialData });

    const loaded = await adapter.load('initial');
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Pre-loaded');

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('initial');
  });

  it('deep-clones initialData so mutations to the source map do not affect the adapter', async () => {
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory(
      { id: 'init-clone', title: 'Original' },
      environment,
    );
    const initialData = new Map<string, typeof conversation>([[conversation.id, conversation]]);

    const adapter = createInMemoryPersistenceAdapter({ initialData });

    // Mutate the original map entry
    (conversation as { title: string }).title = 'Mutated';

    const loaded = await adapter.load('init-clone');
    expect(loaded!.title).toBe('Original');
  });

  it('returns an empty array from list when no sessions exist', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(0);
    expect(sessions).toEqual([]);
  });

  it('omits title from SessionInfo when conversation has no title', async () => {
    const adapter = createInMemoryPersistenceAdapter();
    const environment = createTestConversationEnvironment();
    const conversation = createConversationHistory({ id: 'no-title' }, environment);

    await adapter.save(conversation);

    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    expect('title' in sessions[0]!).toBe(false);
  });
});
