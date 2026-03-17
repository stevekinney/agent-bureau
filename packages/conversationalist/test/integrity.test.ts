import { describe, expect, it } from 'bun:test';

import {
  assertConversationIntegrity,
  validateConversationIntegrity,
} from '../src/conversation/index';
import type { Conversation, Message } from '../src/types';

const createMessage = (overrides: Partial<Message>): Message => ({
  id: 'msg-1',
  role: 'user',
  content: 'hello',
  position: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  metadata: {},
  hidden: false,
  ...overrides,
});

const baseConversation = (): Conversation => ({
  schemaVersion: 1,
  id: 'conv-1',
  status: 'active',
  metadata: {},
  ids: [],
  messages: {},
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
});

describe('integrity', () => {
  it('reports missing messages referenced by ids', () => {
    const conv: Conversation = {
      ...baseConversation(),
      ids: ['missing'],
      messages: {},
    };

    const issues = validateConversationIntegrity(conv);
    expect(issues.some((issue) => issue.code === 'integrity:missing-message')).toBe(true);
  });

  it('reports duplicate message ids in ids', () => {
    const message = createMessage({ id: 'dup' });
    const conv: Conversation = {
      ...baseConversation(),
      ids: [message.id, message.id],
      messages: { [message.id]: message },
    };

    const issues = validateConversationIntegrity(conv);
    expect(issues.some((issue) => issue.code === 'integrity:duplicate-message-id')).toBe(
      true,
    );
  });

  it('reports messages not listed in ids', () => {
    const message = createMessage({ id: 'm1' });
    const conv: Conversation = {
      ...baseConversation(),
      ids: [],
      messages: { [message.id]: message },
    };

    const issues = validateConversationIntegrity(conv);
    expect(issues.some((issue) => issue.code === 'integrity:unlisted-message')).toBe(
      true,
    );
  });

  it('reports orphaned tool results', () => {
    const message = createMessage({
      id: 'm1',
      role: 'tool-result',
      toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
    });
    const conv: Conversation = {
      ...baseConversation(),
      ids: [message.id],
      messages: { [message.id]: message },
    };

    const issues = validateConversationIntegrity(conv);
    expect(issues.some((issue) => issue.code === 'integrity:orphan-tool-result')).toBe(
      true,
    );
  });

  it('reports tool results that occur before their tool use', () => {
    const toolResult = createMessage({
      id: 'm1',
      role: 'tool-result',
      toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
    });
    const toolUse = createMessage({
      id: 'm2',
      role: 'tool-use',
      toolCall: { id: 'call-1', name: 'tool', arguments: {} },
    });

    const conv: Conversation = {
      ...baseConversation(),
      ids: [toolResult.id, toolUse.id],
      messages: { [toolResult.id]: toolResult, [toolUse.id]: toolUse },
    };

    const issues = validateConversationIntegrity(conv);
    expect(
      issues.some((issue) => issue.code === 'integrity:tool-result-before-call'),
    ).toBe(true);
  });

  it('reports duplicate tool call ids', () => {
    const first = createMessage({
      id: 'm1',
      role: 'tool-use',
      toolCall: { id: 'call-1', name: 'tool', arguments: {} },
    });
    const second = createMessage({
      id: 'm2',
      role: 'tool-use',
      toolCall: { id: 'call-1', name: 'tool', arguments: {} },
    });

    const conv: Conversation = {
      ...baseConversation(),
      ids: [first.id, second.id],
      messages: { [first.id]: first, [second.id]: second },
    };

    const issues = validateConversationIntegrity(conv);
    expect(issues.some((issue) => issue.code === 'integrity:duplicate-tool-call')).toBe(
      true,
    );
  });

  it('throws an integrity error when violations exist', () => {
    const conv: Conversation = {
      ...baseConversation(),
      ids: ['missing'],
      messages: {},
    };

    expect(() => assertConversationIntegrity(conv)).toThrowError(
      /conversation integrity check failed/,
    );
  });
});
