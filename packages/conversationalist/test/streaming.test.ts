import { describe, expect, it } from 'bun:test';

import {
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  type IntegrityIssue,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import {
  appendStreamingMessage,
  appendUnsafeStreamingMessage,
  cancelStreamingMessage,
  contentOf,
  createStreamingAccumulator,
  finalizeStreamingMessage,
  finalizeUnsafeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  toolCallsOf,
  updateStreamingMessage,
  updateUnsafeStreamingMessage,
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

describe('unsafe streaming primitives', () => {
  it('updates and finalizes streaming messages on render-side conversations with orphan tool-results', () => {
    const withApprovalPlaceholder = appendUnsafeMessage(
      createConversation({ id: 'test' }, testEnvironment),
      {
        role: 'tool-result',
        content: 'Approval required: shell.exec',
        toolResult: {
          callId: 'apr-1',
          outcome: 'action_required',
          content: 'Waiting for approval',
        },
      },
      testEnvironment,
    );

    try {
      appendStreamingMessage(withApprovalPlaceholder, 'assistant', undefined, testEnvironment);
      throw new Error('Expected appendStreamingMessage to reject the orphan tool-result');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationalistError);
      expect((error as ConversationalistError).code).toBe('error:integrity');
      expect(
        ((error as ConversationalistError).context?.issues as IntegrityIssue[]).some(
          (issue) => issue.code === 'integrity:orphan-tool-result',
        ),
      ).toBe(true);
    }

    const { conversation, messageId } = appendUnsafeStreamingMessage(
      withApprovalPlaceholder,
      'assistant',
      undefined,
      testEnvironment,
    );
    const updated = updateUnsafeStreamingMessage(
      conversation,
      messageId,
      'Approved. Running command.',
      testEnvironment,
    );
    const finalized = finalizeUnsafeStreamingMessage(
      updated,
      messageId,
      { metadata: { rendered: true } },
      testEnvironment,
    );

    const streamingMessage = finalized.messages[messageId];
    expect(streamingMessage?.content).toBe('Approved. Running command.');
    expect(streamingMessage?.metadata.rendered).toBe(true);
    expect(streamingMessage && isStreamingMessage(streamingMessage)).toBe(false);
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

    const result = acc.finalize();
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Hello, world!' }]);
    expect(toolCallsOf(result)).toEqual([]);
  });

  it('returns a client tool_use as a tool-call segment (NOT content) so pairing stays intact', () => {
    const acc = createStreamingAccumulator();
    // Block 0: text
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Let me search.');

    // Block 1: client tool_use with partial JSON deltas
    acc.openBlock(1, { type: 'tool_use', id: 'call-1', name: 'search', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"q":');
    acc.getBlock(1)?.appendInputJsonDelta('"cats"}');

    const result = acc.finalize();
    // The client tool call does NOT land in assistant content — it becomes a
    // tool-call segment so a later tool-result can pair to it.
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Let me search.' }]);
    expect(toolCallsOf(result)).toEqual([
      { id: 'call-1', name: 'search', arguments: { q: 'cats' } },
    ]);
  });

  it('preserves block order with a client tool_use interleaved: [text, tool_use, text] → content/tool-call/content segments', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Before.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-mid', name: 'lookup', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"k":"v"}');
    acc.openBlock(2, { type: 'text', buffer: '' });
    acc.getBlock(2)?.appendTextDelta('After.');

    const { segments } = acc.finalize();
    // The tool call keeps its TRUE position between the two text runs.
    expect(segments).toEqual([
      { kind: 'content', content: [{ type: 'text', text: 'Before.' }] },
      { kind: 'tool-call', toolCall: { id: 'call-mid', name: 'lookup', arguments: { k: 'v' } } },
      { kind: 'content', content: [{ type: 'text', text: 'After.' }] },
    ]);
  });

  it('accumulates a server_tool_use block as server_tool_use content (distinct from client tool_use)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'server_tool_use', id: 'stu-1', name: 'web_search', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":"news"}');

    const result = acc.finalize();
    // Server tool use stays in content; it is part of the assistant turn.
    expect(contentOf(result)).toEqual([
      { type: 'server_tool_use', id: 'stu-1', name: 'web_search', input: { query: 'news' } },
    ]);
    expect(toolCallsOf(result)).toEqual([]);
  });

  it('separates multiple client tool calls in block order, leaving content untouched', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Doing two things.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-a', name: 'first', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"x":1}');
    acc.openBlock(2, { type: 'tool_use', id: 'call-b', name: 'second', inputBuffer: '' });
    acc.getBlock(2)?.appendInputJsonDelta('{"y":2}');

    const result = acc.finalize();
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Doing two things.' }]);
    expect(toolCallsOf(result)).toEqual([
      { id: 'call-a', name: 'first', arguments: { x: 1 } },
      { id: 'call-b', name: 'second', arguments: { y: 2 } },
    ]);
  });

  it('accumulates a thinking block with thinking_delta and signature', () => {
    const SIG = 'test-signature-abc==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('I should think about this.');
    acc.getBlock(0)?.appendSignatureDelta(SIG);

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'I should think about this.', signature: SIG },
    ]);
  });

  it('also accepts text deltas for thinking blocks', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendTextDelta('thinking as text delta');
    acc.getBlock(0)?.appendSignatureDelta('sig==');

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'thinking as text delta', signature: 'sig==' },
    ]);
  });

  it('accumulates a signature delivered across multiple signature_delta chunks byte-for-byte', () => {
    // Anthropic may split the signature across several signature_delta events;
    // appendSignatureDelta must concatenate, not replace, or the byte-for-byte
    // signature breaks extended-thinking replay.
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('reasoning');
    acc.getBlock(0)?.appendSignatureDelta('EqoBCkgIA');
    acc.getBlock(0)?.appendSignatureDelta('RABGAIiQ');
    acc.getBlock(0)?.appendSignatureDelta('L8gy6==');

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'EqoBCkgIARABGAIiQL8gy6==' },
    ]);
  });

  it('accumulates citations_delta entries onto a streamed text block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('The answer is 4.');
    acc.getBlock(0)?.appendCitationsDelta({ type: 'char_location', cited_text: 'a', start: 0 });
    acc.getBlock(0)?.appendCitationsDelta({ type: 'char_location', cited_text: 'b', start: 5 });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'text',
        text: 'The answer is 4.',
        citations: [
          { type: 'char_location', cited_text: 'a', start: 0 },
          { type: 'char_location', cited_text: 'b', start: 5 },
        ],
      },
    ]);
  });

  it('accumulates a streamed web_fetch_tool_result block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'web_fetch_tool_result',
      tool_use_id: 'wf-1',
      content: { url: 'https://example.com', text: 'page body' },
    });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'wf-1',
        content: { url: 'https://example.com', text: 'page body' },
      },
    ]);
  });

  it('accumulates a redacted_thinking block (data seeded at openBlock, no signature)', () => {
    const DATA = 'encrypted-redacted-payload==';
    const acc = createStreamingAccumulator();
    // redacted_thinking carries its encrypted `data` in the start event.
    acc.openBlock(0, { type: 'redacted_thinking', data: DATA });

    expect(contentOf(acc.finalize())).toEqual([{ type: 'redacted_thinking', data: DATA }]);
  });

  it('preserves block order by index regardless of open order', () => {
    const acc = createStreamingAccumulator();
    // Open block 2 first, then 0, then 1
    acc.openBlock(2, { type: 'text', buffer: '' });
    acc.getBlock(2)?.appendTextDelta('Third');

    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('First');
    acc.getBlock(0)?.appendSignatureDelta('sig==');

    acc.openBlock(1, { type: 'text', buffer: '' });
    acc.getBlock(1)?.appendTextDelta('Second');

    const content = contentOf(acc.finalize());
    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe('thinking');
    expect(content[1]?.type).toBe('text');
    expect(content[2]?.type).toBe('text');
    if (content[1]?.type === 'text') expect(content[1].text).toBe('Second');
    if (content[2]?.type === 'text') expect(content[2].text).toBe('Third');
  });

  it('finalizes a zero-argument tool call (no input_json_delta) with input {}', () => {
    // A no-arg tool streams with no input_json_delta, so inputBuffer stays ''.
    // That is a legitimate `{}` input, not a corrupt stream — it must NOT throw.
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'tool_use', id: 'call-noarg', name: 'ping', inputBuffer: '' });

    expect(toolCallsOf(acc.finalize())).toEqual([
      { id: 'call-noarg', name: 'ping', arguments: {} },
    ]);
  });

  it('throws on NON-EMPTY malformed JSON in a tool_use block rather than emitting empty input', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'tool_use', id: 'call-bad', name: 'pay', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{invalid json');

    // A corrupt/incomplete (non-empty) stream must not silently become a
    // valid-looking tool call — finalize throws, naming the tool.
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
    acc.getBlock(0)?.appendSignatureDelta(SIG);

    expect(contentOf(acc.finalize())).toEqual([{ type: 'thinking', thinking: '', signature: SIG }]);
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

    const { segments } = acc.finalize();

    let conversation = createConversationHistory({ id: 'stream-pairing' }, testEnvironment);
    for (const segment of segments) {
      conversation =
        segment.kind === 'content'
          ? appendMessages(
              conversation,
              { role: 'assistant', content: segment.content },
              testEnvironment,
            )
          : appendMessages(
              conversation,
              { role: 'tool-call', content: '', toolCall: segment.toolCall },
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

  it('accumulates a streamed web_search_tool_result block (content seeded at openBlock)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'server_tool_use', id: 'stu-1', name: 'web_search', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":"news"}');
    // The search result arrives as its own block with content in the start event.
    acc.openBlock(1, {
      type: 'web_search_tool_result',
      tool_use_id: 'stu-1',
      content: [{ url: 'https://example.com', title: 'News' }],
    });

    const content = contentOf(acc.finalize());
    expect(content.map((c) => c.type)).toEqual(['server_tool_use', 'web_search_tool_result']);
    expect(content[1]).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: 'stu-1',
      content: [{ url: 'https://example.com', title: 'News' }],
    });
  });

  it('accumulates a streamed code-execution result block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'stu-bash',
      content: { stdout: 'ok', exit_code: 0 },
    });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'stu-bash',
        content: { stdout: 'ok', exit_code: 0 },
      },
    ]);
  });
});
