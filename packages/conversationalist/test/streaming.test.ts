import { describe, expect, it } from 'bun:test';

import { createConversation } from '../src/conversation/index';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  updateStreamingMessage,
} from '../src/streaming';
import type { Conversation, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('appendStreamingMessage', () => {
  it('creates a new streaming message', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    expect(messageId).toMatch(/^test-id-\d+$/);
    expect(conversation.ids).toHaveLength(1);
    expect(getOrderedMessages(conversation)[0]?.role).toBe('assistant');
    expect(getOrderedMessages(conversation)[0]?.content).toBe('');
  });

  it('marks message as streaming via metadata', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    expect(isStreamingMessage(getOrderedMessages(conversation)[0]!)).toBe(true);
  });

  it('preserves custom metadata', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      { custom: 'value' },
      testEnvironment,
    );

    expect(getOrderedMessages(conversation)[0]?.metadata.custom).toBe('value');
  });
});

describe('updateStreamingMessage', () => {
  it('updates message content', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const updated = updateStreamingMessage(
      conversation,
      messageId,
      'Hello',
      testEnvironment,
    );
    expect(getOrderedMessages(updated)[0]?.content).toBe('Hello');
  });

  it('replaces content on each update (for accumulation)', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    let updated = updateStreamingMessage(
      conversation,
      messageId,
      'Hello',
      testEnvironment,
    );
    updated = updateStreamingMessage(updated, messageId, 'Hello world', testEnvironment);

    expect(getOrderedMessages(updated)[0]?.content).toBe('Hello world');
  });

  it('returns unchanged conversation for unknown message ID', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const updated = updateStreamingMessage(
      conversation,
      'unknown-id',
      'Content',
      testEnvironment,
    );
    expect(updated).toBe(conversation);
  });

  it('supports multi-modal content updates', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const updated = updateStreamingMessage(
      conversation,
      messageId,
      [{ type: 'text', text: 'Hello' }],
      testEnvironment,
    );

    expect(Array.isArray(getOrderedMessages(updated)[0]?.content)).toBe(true);
  });

  it('preserves token usage when updating content', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      { tokenUsage: { prompt: 1, completion: 2, total: 3 } },
      testEnvironment,
    );

    const updated = updateStreamingMessage(
      finalized,
      messageId,
      'Updated',
      testEnvironment,
    );

    expect(getOrderedMessages(updated)[0]?.tokenUsage).toEqual({
      prompt: 1,
      completion: 2,
      total: 3,
    });
  });
});

describe('finalizeStreamingMessage', () => {
  it('removes the streaming flag', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      undefined,
      testEnvironment,
    );
    expect(isStreamingMessage(getOrderedMessages(finalized)[0]!)).toBe(false);
  });

  it('adds token usage when provided', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      { tokenUsage: { prompt: 10, completion: 20, total: 30 } },
      testEnvironment,
    );

    expect(getOrderedMessages(finalized)[0]?.tokenUsage).toEqual({
      prompt: 10,
      completion: 20,
      total: 30,
    });
  });

  it('merges additional metadata', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      { original: true },
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      { metadata: { finalized: true } },
      testEnvironment,
    );

    expect(getOrderedMessages(finalized)[0]?.metadata.original).toBe(true);
    expect(getOrderedMessages(finalized)[0]?.metadata.finalized).toBe(true);
  });

  it('returns unchanged conversation for unknown message ID', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      'unknown-id',
      undefined,
      testEnvironment,
    );
    expect(finalized).toBe(conversation);
  });
});

describe('cancelStreamingMessage', () => {
  it('removes the streaming message', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const cancelled = cancelStreamingMessage(conversation, messageId, testEnvironment);
    expect(cancelled.ids).toHaveLength(0);
  });

  it('renumbers remaining messages', async () => {
    const { appendMessages } = await import('../src/conversation/index');
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello' }, testEnvironment);

    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    // Add another message after the streaming one
    const withMore = appendMessages(
      conversation,
      { role: 'user', content: 'Another' },
      testEnvironment,
    );

    // Cancel the streaming message
    const cancelled = cancelStreamingMessage(withMore, messageId, testEnvironment);

    // Positions should be renumbered
    getOrderedMessages(cancelled).forEach((m, i) => {
      expect(m.position).toBe(i);
    });
  });

  it('preserves token usage when renumbering', async () => {
    const { appendMessages } = await import('../src/conversation/index');
    const conv = createConversation({ id: 'test' }, testEnvironment);

    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const withTokenUsage = appendMessages(
      conversation,
      {
        role: 'assistant',
        content: 'Done',
        tokenUsage: { prompt: 1, completion: 2, total: 3 },
      },
      testEnvironment,
    );

    const cancelled = cancelStreamingMessage(withTokenUsage, messageId, testEnvironment);
    const [remaining] = getOrderedMessages(cancelled);
    expect(remaining?.tokenUsage).toEqual({ prompt: 1, completion: 2, total: 3 });
    expect(remaining?.position).toBe(0);
  });

  it('returns unchanged conversation for unknown message ID', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const cancelled = cancelStreamingMessage(conversation, 'unknown-id', testEnvironment);
    expect(cancelled).toBe(conversation);
  });
});

describe('isStreamingMessage', () => {
  it('returns true for streaming messages', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    expect(isStreamingMessage(getOrderedMessages(conversation)[0]!)).toBe(true);
  });

  it('returns false for non-streaming messages', async () => {
    const { appendMessages } = await import('../src/conversation/index');
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello' }, testEnvironment);

    expect(isStreamingMessage(getOrderedMessages(conv)[0]!)).toBe(false);
  });

  it('returns false for finalized streaming messages', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );
    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      undefined,
      testEnvironment,
    );

    expect(isStreamingMessage(getOrderedMessages(finalized)[0]!)).toBe(false);
  });
});

describe('getStreamingMessage', () => {
  it('returns the streaming message if one exists', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const streaming = getStreamingMessage(conversation);
    expect(streaming?.id).toBe(messageId);
  });

  it('returns undefined if no streaming message exists', async () => {
    const { appendMessages } = await import('../src/conversation/index');
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello' }, testEnvironment);

    const streaming = getStreamingMessage(conv);
    expect(streaming).toBeUndefined();
  });

  it('returns undefined after message is finalized', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );
    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      undefined,
      testEnvironment,
    );

    const streaming = getStreamingMessage(finalized);
    expect(streaming).toBeUndefined();
  });
});
