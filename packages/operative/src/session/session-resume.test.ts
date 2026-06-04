import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';
import { resumeSession } from './session-resume';

describe('resumeSession', () => {
  it('loads an existing session and returns a conversation with its history', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const conversation = new Conversation();
    conversation.appendSystemMessage('You are helpful.');
    conversation.appendUserMessage('Hello');
    conversation.appendAssistantMessage('Hi there!');

    const session = createAgentSession({
      agentName: 'resume-agent',
      conversationHistory: conversation.current,
      id: 'existing-session',
    });
    await store.save(session);

    const result = await resumeSession(store, 'existing-session', {
      agentName: 'resume-agent',
    });

    expect(result.session.id).toBe('existing-session');
    expect(result.isNew).toBe(false);
    expect(result.conversation).toBeInstanceOf(Conversation);
    // The restored conversation should have the same messages
    expect(result.conversation.current.ids.length).toBe(3);
  });

  it('creates a new session when the id is not found', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const result = await resumeSession(store, 'brand-new', {
      agentName: 'new-agent',
    });

    expect(result.session.id).toBe('brand-new');
    expect(result.session.agentName).toBe('new-agent');
    expect(result.isNew).toBe(true);
    expect(result.conversation).toBeInstanceOf(Conversation);
    expect(result.conversation.current.ids.length).toBe(0);
  });

  it('handles corrupted data gracefully by creating a new session', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    // Write garbage directly to the underlying store
    await kv.set('agent-session:corrupt-id', 'not-valid-json{{{');

    const result = await resumeSession(store, 'corrupt-id', {
      agentName: 'graceful-agent',
    });

    expect(result.isNew).toBe(true);
    expect(result.session.id).toBe('corrupt-id');
    expect(result.session.agentName).toBe('graceful-agent');
  });

  it('applies provided metadata to new sessions', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const result = await resumeSession(store, 'meta-session', {
      agentName: 'meta-agent',
      metadata: { source: 'test' },
    });

    expect(result.session.metadata).toEqual({ source: 'test' });
  });

  it('preserves metadata from existing sessions', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'existing-meta',
      conversationHistory: createConversationHistory(),
      id: 'meta-existing',
      metadata: { existing: 'data' },
    });
    await store.save(session);

    const result = await resumeSession(store, 'meta-existing', {
      agentName: 'existing-meta',
    });

    expect(result.session.metadata).toEqual({ existing: 'data' });
    expect(result.isNew).toBe(false);
  });
});
