import { describe, expect, it } from 'bun:test';

import { createConversationHistory as createConversation } from '../src/conversation/index';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  createStreamingAccumulator,
  finalizeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  updateStreamingMessage,
} from '../src/streaming';
import type { ConversationHistory as Conversation, Message } from '../src/types';

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
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

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

    const updated = updateStreamingMessage(conversation, messageId, 'Hello', testEnvironment);
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

    let updated = updateStreamingMessage(conversation, messageId, 'Hello', testEnvironment);
    updated = updateStreamingMessage(updated, messageId, 'Hello world', testEnvironment);

    expect(getOrderedMessages(updated)[0]?.content).toBe('Hello world');
  });

  it('returns unchanged conversation for unknown message ID', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

    const updated = updateStreamingMessage(conversation, 'unknown-id', 'Content', testEnvironment);
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

    const updated = updateStreamingMessage(finalized, messageId, 'Updated', testEnvironment);

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

    const finalized = finalizeStreamingMessage(conversation, messageId, undefined, testEnvironment);
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
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

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
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

    const cancelled = cancelStreamingMessage(conversation, 'unknown-id', testEnvironment);
    expect(cancelled).toBe(conversation);
  });
});

describe('isStreamingMessage', () => {
  it('returns true for streaming messages', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

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
    const finalized = finalizeStreamingMessage(conversation, messageId, undefined, testEnvironment);

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
    const finalized = finalizeStreamingMessage(conversation, messageId, undefined, testEnvironment);

    const streaming = getStreamingMessage(finalized);
    expect(streaming).toBeUndefined();
  });
});

describe('C4 — createStreamingAccumulator (multi-part accumulation)', () => {
  it('accumulates a single text block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Hello');
    acc.getBlock(0)?.appendTextDelta(', world!');

    const { content, toolCalls } = acc.finalize();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: 'Hello, world!' });
    expect(toolCalls).toEqual([]);
  });

  it('returns a client tool_use as a tool-call (in toolCalls, NOT content) so pairing stays intact', () => {
    const acc = createStreamingAccumulator();
    // Block 0: text
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Let me search.');

    // Block 1: client tool_use with partial JSON deltas
    acc.openBlock(1, { type: 'tool_use', id: 'call-1', name: 'search', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"q":');
    acc.getBlock(1)?.appendInputJsonDelta('"cats"}');

    const { content, toolCalls } = acc.finalize();
    // The client tool call does NOT land in assistant content — it becomes a
    // tool-call so a later tool-result can pair to it.
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: 'Let me search.' });
    expect(toolCalls).toEqual([{ id: 'call-1', name: 'search', arguments: { q: 'cats' } }]);
  });

  it('accumulates a server_tool_use block as server_tool_use content (distinct from client tool_use)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'server_tool_use', id: 'stu-1', name: 'web_search', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":"news"}');

    const { content, toolCalls } = acc.finalize();
    // Server tool use stays in content; it is part of the assistant turn.
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'server_tool_use',
      id: 'stu-1',
      name: 'web_search',
      input: { query: 'news' },
    });
    expect(toolCalls).toEqual([]);
  });

  it('separates multiple client tool calls in block order, leaving content untouched', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Doing two things.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-a', name: 'first', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"x":1}');
    acc.openBlock(2, { type: 'tool_use', id: 'call-b', name: 'second', inputBuffer: '' });
    acc.getBlock(2)?.appendInputJsonDelta('{"y":2}');

    const { content, toolCalls } = acc.finalize();
    expect(content).toEqual([{ type: 'text', text: 'Doing two things.' }]);
    expect(toolCalls).toEqual([
      { id: 'call-a', name: 'first', arguments: { x: 1 } },
      { id: 'call-b', name: 'second', arguments: { y: 2 } },
    ]);
  });

  it('accumulates a thinking block with thinking_delta and signature', () => {
    const SIG = 'test-signature-abc==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('I should think about this.');
    acc.getBlock(0)?.setSignature(SIG);

    const { content } = acc.finalize();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'thinking',
      thinking: 'I should think about this.',
      signature: SIG,
    });
  });

  it('accumulates a redacted_thinking block (no thinking_delta, only signature)', () => {
    const SIG = 'redacted-signature==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'redacted_thinking', signature: '' });
    acc.getBlock(0)?.setSignature(SIG);

    const { content } = acc.finalize();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'redacted_thinking', signature: SIG });
  });

  it('preserves block order by index regardless of open order', () => {
    const acc = createStreamingAccumulator();
    // Open block 2 first, then 0, then 1
    acc.openBlock(2, { type: 'text', buffer: '' });
    acc.getBlock(2)?.appendTextDelta('Third');

    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('First');
    acc.getBlock(0)?.setSignature('sig==');

    acc.openBlock(1, { type: 'text', buffer: '' });
    acc.getBlock(1)?.appendTextDelta('Second');

    const { content } = acc.finalize();
    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe('thinking');
    expect(content[1]?.type).toBe('text');
    expect(content[2]?.type).toBe('text');
    if (content[1]?.type === 'text') expect(content[1].text).toBe('Second');
    if (content[2]?.type === 'text') expect(content[2].text).toBe('Third');
  });

  it('throws on malformed JSON in a tool_use block rather than emitting empty input', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'tool_use', id: 'call-bad', name: 'pay', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{invalid json');

    // A corrupt/incomplete stream must not silently become a valid-looking
    // tool call with empty input — finalize throws, naming the tool.
    expect(() => acc.finalize()).toThrow(/Streamed tool input for "pay" is not valid JSON/);
  });

  it('throws on malformed JSON in a server_tool_use block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'server_tool_use',
      id: 'stu-bad',
      name: 'web_search',
      inputBuffer: '',
    });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":');

    expect(() => acc.finalize()).toThrow(/Streamed tool input for "web_search" is not valid JSON/);
  });

  it('finalizes a thinking block with an empty buffer when no thinking_delta arrives', () => {
    const SIG = 'sig-only==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    // Only the signature arrives (no thinking_delta).
    acc.getBlock(0)?.setSignature(SIG);

    const { content } = acc.finalize();
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'thinking', thinking: '', signature: SIG });
  });

  it('getBlock returns undefined for a block index that has not been opened', () => {
    const acc = createStreamingAccumulator();
    expect(acc.getBlock(99)).toBeUndefined();
  });

  it('round-trips a streamed client tool call into a conversation and pairs its tool-result', async () => {
    // Regression for the Cursor finding: a streamed client tool_use must produce
    // a tool-call message so a later tool-result pairs to it. Appending the
    // assistant content + the tool-call + the matching tool-result must NOT throw
    // an orphan-tool-result integrity error.
    const { appendMessages, createConversationHistory } = await import('../src/conversation/index');

    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Let me pay.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-pay', name: 'pay', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"amount":5}');

    const { content, toolCalls } = acc.finalize();

    let conversation = createConversationHistory({ id: 'stream-pairing' }, testEnvironment);
    conversation = appendMessages(conversation, { role: 'assistant', content }, testEnvironment);
    for (const toolCall of toolCalls) {
      conversation = appendMessages(
        conversation,
        { role: 'tool-call', content: '', toolCall },
        testEnvironment,
      );
    }

    // The matching tool-result pairs cleanly — no throw.
    expect(() => {
      appendMessages(
        conversation,
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-pay', outcome: 'success', content: { ok: true } },
        },
        testEnvironment,
      );
    }).not.toThrow();
  });
});
