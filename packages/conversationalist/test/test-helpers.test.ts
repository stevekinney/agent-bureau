import { describe, expect, it } from 'bun:test';

import { createTestConversation, createConversationRecorder } from '../src/test';

describe('test helper exports', () => {
  it('creates a deterministic Conversation instance for tests', () => {
    const conversation = createTestConversation(undefined, {
      identifiers: ['message-id-1'],
      now: '2024-02-02T00:00:00.000Z',
    });

    conversation.appendUserMessage('hello');

    expect(conversation.current.ids).toHaveLength(1);
    expect(conversation.current.messages[conversation.current.ids[0]!]!.content).toBe('hello');
  });

  it('records conversation mutations through createConversationRecorder', () => {
    const conversation = createTestConversation();
    const recorder = createConversationRecorder(conversation);

    conversation.appendUserMessage('first');
    conversation.undo();

    expect(recorder.events.map((event) => event.type)).toEqual([
      'change',
      'push',
      'change',
      'undo',
    ]);

    recorder.clear();
    expect(recorder.events).toHaveLength(0);

    expect(() => {
      (recorder as { [Symbol.dispose]: () => void })[Symbol.dispose]();
    }).not.toThrow();
  });
});
