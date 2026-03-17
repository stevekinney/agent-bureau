import { describe, expect, it } from 'bun:test';

import {
  appendToolResult,
  appendToolUse,
  createConversation,
  getPendingToolCalls,
  getToolInteractions,
} from '../src/conversation/index';
import type { Conversation, Message } from '../src/types';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `call-${++counter}`;
  })(),
};

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('tool interaction helpers', () => {
  it('appends tool-use and tool-result messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolUse(conv, {
      toolId: 'tool',
      args: { input: 'value' },
    });
    const callId = getOrderedMessages(conv)[0]?.toolCall?.id;
    expect(callId).toBeDefined();

    conv = appendToolResult(conv, {
      callId: callId!,
      outcome: 'success',
      result: { ok: true },
    });

    const messages = getOrderedMessages(conv);
    expect(messages[0]?.role).toBe('tool-use');
    expect(messages[1]?.role).toBe('tool-result');
  });

  it('returns pending tool calls without results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolUse(conv, {
      toolId: 'tool',
      callId: 'call-1',
      args: { input: 'value' },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call-1');
  });

  it('returns no pending calls after results are recorded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolUse(conv, {
      toolId: 'tool',
      callId: 'call-1',
      args: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      result: { ok: true },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(0);
  });

  it('pairs tool calls with results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolUse(conv, {
      toolId: 'tool',
      callId: 'call-1',
      args: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      result: { ok: true },
    });

    const interactions = getToolInteractions(conv);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.call.id).toBe('call-1');
    expect(interactions[0]?.result?.outcome).toBe('success');
  });

  it('generates call IDs when omitted', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolUse(
      conv,
      {
        toolId: 'tool',
        args: { input: 'value' },
      },
      undefined,
      testEnvironment,
    );

    const [message] = getOrderedMessages(conv);
    expect(message?.toolCall?.id).toBe('call-1');
  });

  it('rejects tool results without a matching tool call', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(() =>
      appendToolResult(
        conv,
        {
          callId: 'missing',
          outcome: 'success',
          result: { ok: true },
        },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });
});
