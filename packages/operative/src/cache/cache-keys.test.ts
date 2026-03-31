import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { GenerateContext } from '../types';
import { conversationHashKey, lastMessageKey } from './cache-keys';

function makeContext(overrides: Partial<GenerateContext> = {}): GenerateContext {
  const conversation = new Conversation();
  return {
    conversation,
    step: 1,
    toolbox: createTestToolbox([]),
    ...overrides,
  };
}

describe('conversationHashKey', () => {
  it('returns a hex string', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    const context = makeContext({ conversation });

    const key = conversationHashKey(context);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same key for identical conversations', () => {
    const c1 = new Conversation();
    c1.appendUserMessage('Hello');
    const c2 = new Conversation();
    c2.appendUserMessage('Hello');

    const key1 = conversationHashKey(makeContext({ conversation: c1 }));
    const key2 = conversationHashKey(makeContext({ conversation: c2 }));
    expect(key1).toBe(key2);
  });

  it('produces different keys for different messages', () => {
    const c1 = new Conversation();
    c1.appendUserMessage('Hello');
    const c2 = new Conversation();
    c2.appendUserMessage('Goodbye');

    const key1 = conversationHashKey(makeContext({ conversation: c1 }));
    const key2 = conversationHashKey(makeContext({ conversation: c2 }));
    expect(key1).not.toBe(key2);
  });

  it('includes tool names in the hash (sorted)', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const alpha = createTool({ name: 'alpha', description: 'a', execute: async () => 'ok' });
    const beta = createTool({ name: 'beta', description: 'b', execute: async () => 'ok' });

    const toolboxA = createTestToolbox([alpha, beta]);
    const toolboxB = createTestToolbox([beta, alpha]);

    const key1 = conversationHashKey(makeContext({ conversation, toolbox: toolboxA }));
    const key2 = conversationHashKey(makeContext({ conversation, toolbox: toolboxB }));
    expect(key1).toBe(key2);
  });

  it('produces different keys when tool sets differ', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const alpha = createTool({ name: 'alpha', description: 'a', execute: async () => 'ok' });
    const beta = createTool({ name: 'beta', description: 'b', execute: async () => 'ok' });

    const toolboxA = createTestToolbox([alpha]);
    const toolboxB = createTestToolbox([beta]);

    const key1 = conversationHashKey(makeContext({ conversation, toolbox: toolboxA }));
    const key2 = conversationHashKey(makeContext({ conversation, toolbox: toolboxB }));
    expect(key1).not.toBe(key2);
  });

  it('handles an empty conversation', () => {
    const context = makeContext();
    const key = conversationHashKey(context);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('lastMessageKey', () => {
  it('returns a hex string', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    const key = lastMessageKey(makeContext({ conversation }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same key when the last user message is the same', () => {
    const c1 = new Conversation();
    c1.appendUserMessage('First');
    c1.appendUserMessage('Hello');

    const c2 = new Conversation();
    c2.appendUserMessage('Different first');
    c2.appendUserMessage('Hello');

    const key1 = lastMessageKey(makeContext({ conversation: c1 }));
    const key2 = lastMessageKey(makeContext({ conversation: c2 }));
    expect(key1).toBe(key2);
  });

  it('produces different keys for different last messages', () => {
    const c1 = new Conversation();
    c1.appendUserMessage('Hello');

    const c2 = new Conversation();
    c2.appendUserMessage('Goodbye');

    const key1 = lastMessageKey(makeContext({ conversation: c1 }));
    const key2 = lastMessageKey(makeContext({ conversation: c2 }));
    expect(key1).not.toBe(key2);
  });

  it('includes the system prompt in the hash', () => {
    const c1 = new Conversation();
    c1.appendSystemMessage('You are helpful');
    c1.appendUserMessage('Hello');

    const c2 = new Conversation();
    c2.appendSystemMessage('You are rude');
    c2.appendUserMessage('Hello');

    const key1 = lastMessageKey(makeContext({ conversation: c1 }));
    const key2 = lastMessageKey(makeContext({ conversation: c2 }));
    expect(key1).not.toBe(key2);
  });

  it('handles a conversation with no user messages', () => {
    const conversation = new Conversation();
    const key = lastMessageKey(makeContext({ conversation }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
