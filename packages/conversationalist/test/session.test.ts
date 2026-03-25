import { describe, expect, it } from 'bun:test';

import { createConversationHistory } from '../src/conversation/index';
import { Conversation, type ConversationEvent } from '../src/history';
import { createTestConversation, createTestConversationEnvironment } from '../src/test/index';

describe('Conversation.fork', () => {
  it('creates a new Conversation with a deep copy of the current state', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi there');

    const forked = conversation.fork();

    expect(forked).toBeInstanceOf(Conversation);
    expect(forked).not.toBe(conversation);
    expect(forked.current.id).not.toBe(conversation.current.id);
    expect(forked.current.ids).toHaveLength(2);
    expect(forked.getMessages()[0].content).toBe('Hello');
    expect(forked.getMessages()[1].content).toBe('Hi there');
  });

  it('assigns a new id to the forked conversation using the environment randomId', () => {
    const environment = createTestConversationEnvironment({
      identifiers: ['original-id', 'msg-1', 'forked-id'],
    });
    const conversation = new Conversation(
      createConversationHistory(undefined, environment),
      environment,
    );
    conversation.appendUserMessage('Hello');

    const forked = conversation.fork();

    expect(forked.current.id).toBe('forked-id');
  });

  it('does not mutate the source conversation', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');

    const beforeFork = conversation.current;
    const forked = conversation.fork();

    expect(conversation.current).toBe(beforeFork);

    forked.appendUserMessage('New message in fork');
    expect(conversation.current.ids).toHaveLength(1);
    expect(forked.current.ids).toHaveLength(2);
  });

  it('truncates to the specified messageId when provided', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('First');
    conversation.appendAssistantMessage('Second');
    conversation.appendUserMessage('Third');

    const messageIds = conversation.current.ids;
    const secondMessageId = messageIds[1];

    const forked = conversation.fork(secondMessageId);

    expect(forked.current.ids).toHaveLength(2);
    expect(forked.getMessages()[0].content).toBe('First');
    expect(forked.getMessages()[1].content).toBe('Second');
  });

  it('throws an error if the specified messageId does not exist', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');

    expect(() => conversation.fork('nonexistent-id')).toThrow(
      'Message with id "nonexistent-id" not found',
    );
  });

  it('emits session.forked and change events on the source conversation', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');

    const events: string[] = [];
    conversation.addEventListener('session.forked', (event: ConversationEvent) => {
      events.push(event.action);
    });
    conversation.addEventListener('change', (event: ConversationEvent) => {
      events.push(`change:${event.action}`);
    });

    conversation.fork();

    expect(events).toContain('session.forked');
    expect(events).toContain('change:session.forked');
  });

  it('shares the same environment between source and forked conversation', () => {
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory(undefined, environment),
      environment,
    );

    const forked = conversation.fork();

    expect(forked.env.now).toBe(conversation.env.now);
    expect(forked.env.estimateTokens).toBe(conversation.env.estimateTokens);
  });

  it('performs a deep copy so modifying forked messages does not affect source', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');

    const forked = conversation.fork();

    const sourceMessage = conversation.getMessages()[0];
    const forkedMessage = forked.getMessages()[0];

    expect(forkedMessage.content).toBe(sourceMessage.content);
    expect(forkedMessage.id).toBe(sourceMessage.id);
  });
});

describe('Conversation.tag', () => {
  it('adds a tag to the conversation metadata under _tags', () => {
    const conversation = createTestConversation();
    conversation.tag('important');

    const tags = conversation.current.metadata['_tags'] as string[];
    expect(tags).toEqual(['important']);
  });

  it('supports multiple tags', () => {
    const conversation = createTestConversation();
    conversation.tag('first');
    conversation.tag('second');

    const tags = conversation.current.metadata['_tags'] as string[];
    expect(tags).toEqual(['first', 'second']);
  });

  it('deduplicates tags — adding the same tag twice is a no-op', () => {
    const conversation = createTestConversation();
    conversation.tag('duplicate');
    const afterFirst = conversation.current;

    conversation.tag('duplicate');

    const tags = conversation.current.metadata['_tags'] as string[];
    expect(tags).toEqual(['duplicate']);
    expect(conversation.current).toBe(afterFirst);
  });

  it('emits session.tagged and change events', () => {
    const conversation = createTestConversation();
    const events: string[] = [];

    conversation.addEventListener('session.tagged', (event: ConversationEvent) => {
      events.push(event.action);
    });
    conversation.addEventListener('change', (event: ConversationEvent) => {
      if (event.action === 'session.tagged') {
        events.push(`change:${event.action}`);
      }
    });

    conversation.tag('important');

    expect(events).toContain('session.tagged');
    expect(events).toContain('change:session.tagged');
  });

  it('updates the updatedAt timestamp', () => {
    let callCount = 0;
    const environment = createTestConversationEnvironment({
      now: () => {
        callCount++;
        return callCount <= 1 ? '2024-01-01T00:00:00.000Z' : '2024-06-15T12:00:00.000Z';
      },
    });

    const conversation = new Conversation(
      createConversationHistory(undefined, environment),
      environment,
    );

    conversation.tag('timestamped');

    expect(conversation.current.updatedAt).toBe('2024-06-15T12:00:00.000Z');
  });

  it('preserves existing metadata when adding a tag', () => {
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ metadata: { key: 'value' } }, environment),
      environment,
    );

    conversation.tag('test');

    expect(conversation.current.metadata['key']).toBe('value');
    expect(conversation.current.metadata['_tags'] as string[]).toEqual(['test']);
  });

  it('supports undo after tagging', () => {
    const conversation = createTestConversation();
    const before = conversation.current;

    conversation.tag('undoable');

    expect(conversation.canUndo).toBe(true);
    conversation.undo();
    expect(conversation.current).toBe(before);
    expect(conversation.current.metadata['_tags']).toBeUndefined();
  });
});

describe('Conversation.rename', () => {
  it('updates the conversation title', () => {
    const conversation = createTestConversation();
    conversation.rename('New Title');

    expect(conversation.current.title).toBe('New Title');
  });

  it('emits session.renamed and change events', () => {
    const conversation = createTestConversation();
    const events: string[] = [];

    conversation.addEventListener('session.renamed', (event: ConversationEvent) => {
      events.push(event.action);
    });
    conversation.addEventListener('change', (event: ConversationEvent) => {
      if (event.action === 'session.renamed') {
        events.push(`change:${event.action}`);
      }
    });

    conversation.rename('Updated Title');

    expect(events).toContain('session.renamed');
    expect(events).toContain('change:session.renamed');
  });

  it('updates the updatedAt timestamp', () => {
    let callCount = 0;
    const environment = createTestConversationEnvironment({
      now: () => {
        callCount++;
        return callCount <= 1 ? '2024-01-01T00:00:00.000Z' : '2024-06-15T12:00:00.000Z';
      },
    });

    const conversation = new Conversation(
      createConversationHistory(undefined, environment),
      environment,
    );

    conversation.rename('Renamed');

    expect(conversation.current.updatedAt).toBe('2024-06-15T12:00:00.000Z');
  });

  it('preserves existing messages and metadata', () => {
    const conversation = createTestConversation();
    conversation.appendUserMessage('Hello');

    conversation.rename('My Chat');

    expect(conversation.current.title).toBe('My Chat');
    expect(conversation.current.ids).toHaveLength(1);
    expect(conversation.getMessages()[0].content).toBe('Hello');
  });

  it('supports undo after renaming', () => {
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ title: 'Original' }, environment),
      environment,
    );

    conversation.rename('Renamed');

    expect(conversation.canUndo).toBe(true);
    conversation.undo();
    expect(conversation.current.title).toBe('Original');
  });

  it('is a no-op when the title is unchanged', () => {
    const environment = createTestConversationEnvironment();
    const conversation = new Conversation(
      createConversationHistory({ title: 'Same Title' }, environment),
      environment,
    );
    const before = conversation.current;

    conversation.rename('Same Title');

    expect(conversation.current).toBe(before);
  });
});
