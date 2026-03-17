import { describe, expect, test } from 'bun:test';

import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  collapseSystemMessages,
  createConversation,
  deserializeConversation,
  getFirstSystemMessage,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getStatistics,
  getSystemMessages,
  hasSystemMessage,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
  searchConversationMessages,
  toChatMessages,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import type { Conversation, JSONValue, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('conversation (functional)', () => {
  test('create, append, statistics and encode', () => {
    let c = createConversation({ title: 'Demo' });
    c = appendUserMessage(c, 'hello');
    c = appendAssistantMessage(c, [
      { type: 'text', text: 'ok' },
      { type: 'image', url: 'https://example.com/i.png' },
    ]);

    const stats = getStatistics(c);
    expect(stats.total).toBe(2);
    expect(stats.byRole['user']).toBe(1);
    expect(stats.withImages).toBe(1);

    const external = toChatMessages(c);
    expect(external.length).toBe(2);
    expect(external[0]!.role).toBe('user');
  });

  test('redact message by position', () => {
    let c = createConversation();
    c = appendUserMessage(c, 'secret');
    c = redactMessageAtPosition(c, 0, '[REDACTED]');
    expect(getOrderedMessages(c)[0]!.content).toBe('[REDACTED]');
  });

  test('redaction preserves tool metadata by default', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'tool-use',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: {
          callId: 'call-1',
          outcome: 'success',
          content: { ok: true },
        },
      },
    );

    c = redactMessageAtPosition(c, 0, { placeholder: '[MASKED]' });
    const toolUse = getOrderedMessages(c)[0]!;
    expect(toolUse.toolCall?.id).toBe('call-1');
    expect(toolUse.toolCall?.name).toBe('tool');
    expect(toolUse.toolCall?.arguments).toBe('[MASKED]');

    c = redactMessageAtPosition(c, 1, { placeholder: '[MASKED]' });
    const toolResult = getOrderedMessages(c)[1]!;
    expect(toolResult.toolResult?.callId).toBe('call-1');
    expect(toolResult.toolResult?.outcome).toBe('success');
    expect(toolResult.toolResult?.content).toBe('[MASKED]');
  });

  test('redaction accepts an environment argument for timestamps', () => {
    const env = { now: () => '2024-02-02T00:00:00.000Z' };
    let c = createConversation();
    c = appendUserMessage(c, 'secret');

    const redacted = redactMessageAtPosition(c, 0, env);
    expect(getOrderedMessages(redacted)[0]!.content).toBe('[REDACTED]');
    expect(redacted.updatedAt).toBe('2024-02-02T00:00:00.000Z');
  });

  test('redaction can clear tool metadata when requested', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'tool-use',
      content: '',
      toolCall: { id: 'call-1', name: 'tool', arguments: {} },
    });

    c = redactMessageAtPosition(c, 0, { clearToolMetadata: true });
    const message = getOrderedMessages(c)[0]!;
    expect(message.toolCall).toBeUndefined();
    expect(message.toolResult).toBeUndefined();
  });

  test('rejects non-JSON metadata payloads', () => {
    const c = createConversation();
    expect(() =>
      appendMessages(c, {
        role: 'user',
        content: 'hello',
        metadata: { when: new Date() as unknown as JSONValue },
      }),
    ).toThrow(ConversationalistError);
  });

  test('getMessages includeHidden and lookup helpers', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 's', metadata: { v: 1 } },
      { role: 'user', content: 'u', hidden: true },
    );
    const visible = getMessages(c);
    expect(visible.length).toBe(1);
    const all = getMessages(c, { includeHidden: true });
    expect(all.length).toBe(2);
    expect(getMessageAtPosition(c, 1)?.role).toBe('user');
    const id = all[0]!.id;
    expect(getMessageById(c, id)?.id).toBe(id);
    expect(getMessageIds(c)).toEqual(all.map((message) => message.id));
    expect(searchConversationMessages(c, (m) => m.role === 'system').length).toBe(1);
  });

  test('toChatMessages role mapping and filtering', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 's' },
      { role: 'developer', content: 'd' },
      {
        role: 'tool-use',
        content: 'fc',
        toolCall: { id: 'c1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'tr',
        toolResult: { callId: 'c1', outcome: 'success', content: {} },
      },
      { role: 'snapshot', content: 'snap' },
      { role: 'user', content: 'hidden', hidden: true },
    );
    const ext = toChatMessages(c);
    // hidden filtered -> 7 messages
    expect(ext.length).toBe(7);
    // spot check some roles
    expect(ext[0]!.role).toBe('user');
    expect(ext[1]!.role).toBe('assistant');
    expect(ext[2]!.role).toBe('system');
  });

  test('redact out of range throws', () => {
    const c = createConversation();
    expect(() => redactMessageAtPosition(c, 0)).toThrow(ConversationalistError);
  });

  test('redact throws when the message id is missing', () => {
    const base = createConversation();
    const broken: Conversation = {
      ...base,
      ids: ['missing'],
      messages: {},
    };
    expect(() => redactMessageAtPosition(broken, 0)).toThrow(ConversationalistError);
  });

  test('deserialize validation: position contiguity and tool references', () => {
    const now = new Date().toISOString();
    // Position mismatch
    const badPos = {
      schemaVersion: 1,
      id: 'c',
      status: 'active' as const,
      metadata: {},
      ids: ['m1'],
      messages: {
        m1: {
          id: 'm1',
          role: 'user',
          content: 'x',
          position: 2,
          createdAt: now,
          metadata: {},
          hidden: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(badPos as any)).toThrow(ConversationalistError);

    // Missing tool reference
    const badTool = {
      schemaVersion: 1,
      id: 'c2',
      status: 'active' as const,
      metadata: {},
      ids: ['t'],
      messages: {
        t: {
          id: 't',
          role: 'tool-result',
          content: 'x',
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
          toolResult: { callId: 'nope', outcome: 'error', content: {} },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(badTool as any)).toThrow(ConversationalistError);
  });

  test('deserialize rejects invalid schema data', () => {
    expect(() => deserializeConversation({} as any)).toThrow(ConversationalistError);
  });

  test('deserialize rejects missing messages and unlisted messages', () => {
    const now = new Date().toISOString();
    const missingMessage = {
      schemaVersion: 1,
      id: 'c3',
      status: 'active' as const,
      metadata: {},
      ids: ['missing'],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(missingMessage as any)).toThrow(
      ConversationalistError,
    );

    const unlistedMessage = {
      schemaVersion: 1,
      id: 'c4',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {
        m1: {
          id: 'm1',
          role: 'user',
          content: 'x',
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(unlistedMessage as any)).toThrow(
      ConversationalistError,
    );
  });

  test('deserialize handles conversation input with metadata', () => {
    let c = createConversation({
      title: 'T',
      status: 'active',
      metadata: { source: 'x' },
    });
    c = appendUserMessage(c, 'hi', { foo: 1 });
    const restored = deserializeConversation(c);
    expect(restored.title).toBe('T');
    expect(getOrderedMessages(restored)[0]!.metadata.foo).toBe(1);
    expect(restored.ids).toEqual(c.ids);
  });
  test('tool linkage is validated across batch', () => {
    let c = createConversation();
    expect(() =>
      appendMessages(c, {
        role: 'tool-result',
        content: 'x',
        toolResult: { callId: 'missing', outcome: 'error', content: {} },
      }),
    ).toThrow(ConversationalistError);

    // Valid when tool-use precedes in batch
    c = appendMessages(
      c,
      {
        role: 'tool-use',
        content: 'call',
        toolCall: { id: 'call-1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'ok',
        toolResult: { callId: 'call-1', outcome: 'success', content: {} },
      },
    );
    expect(c.ids.length).toBe(2);
  });

  test('appendMessages rejects duplicate tool call ids', () => {
    const c = createConversation();
    expect(() =>
      appendMessages(
        c,
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'dup', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-use',
          content: '',
          toolCall: { id: 'dup', name: 'tool', arguments: {} },
        },
      ),
    ).toThrow(ConversationalistError);
  });

  test('append tool referencing prior tool-use in existing conversation', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'tool-use',
      content: 'call',
      toolCall: { id: 'prev-call', name: 't', arguments: {} },
    });
    // Second append references tool-use from previous state
    c = appendMessages(c, {
      role: 'tool-result',
      content: 'ok',
      toolResult: { callId: 'prev-call', outcome: 'success', content: {} },
    });
    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(2);
    expect(messages[1]!.role).toBe('tool-result');
  });

  test('deserialize with tool-use and tool-result preserves linkage', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'tool-use',
        content: 'call',
        toolCall: { id: 'dc1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'ok',
        toolResult: { callId: 'dc1', outcome: 'success', content: {} },
      },
    );
    const restored = deserializeConversation(c);
    const restoredMessages = getOrderedMessages(restored);
    expect(restoredMessages.length).toBe(2);
    expect(restoredMessages[0]!.toolCall?.id).toBe('dc1');
    expect(restoredMessages[1]!.toolResult?.callId).toBe('dc1');
  });

  test('appendMessages respects injected environment for ids and timestamps', () => {
    const env = {
      now: () => '2000-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
    };
    const base = createConversation();
    const next = appendMessages(base, { role: 'user', content: 'hello' }, env);
    const messages = getOrderedMessages(next);
    expect(messages[0]!.id).toBe('custom-id');
    expect(messages[0]!.createdAt).toBe('2000-01-01T00:00:00.000Z');
    expect(next.updatedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  test('appendMessages can be invoked without inputs', () => {
    const base = createConversation();
    const next = appendMessages(base);
    expect(next.ids.length).toBe(0);
    expect(next).not.toBe(base);
  });

  test('appendMessages accepts only an environment argument', () => {
    const base = createConversation();
    const env = { now: () => '2024-05-05T05:05:05.000Z' };
    const next = appendMessages(base, env);
    expect(next.ids.length).toBe(0);
    expect(next.updatedAt).toBe('2024-05-05T05:05:05.000Z');
  });
});

describe('system message management', () => {
  test('hasSystemMessage returns true when system message exists', () => {
    let c = createConversation();
    expect(hasSystemMessage(c)).toBeFalse();

    c = appendSystemMessage(c, 'system prompt');
    expect(hasSystemMessage(c)).toBeTrue();
  });

  test('hasSystemMessage includes hidden system messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'system', content: 'hidden', hidden: true });
    expect(hasSystemMessage(c)).toBeTrue();
  });

  test('getFirstSystemMessage returns first system message', () => {
    let c = createConversation();
    expect(getFirstSystemMessage(c)).toBeUndefined();

    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
    );

    const first = getFirstSystemMessage(c);
    expect(first).toBeDefined();
    expect(first!.content).toBe('s1');
    expect(first!.position).toBe(1);
  });

  test('getFirstSystemMessage includes hidden messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'system', content: 'hidden', hidden: true });

    const first = getFirstSystemMessage(c);
    expect(first).toBeDefined();
    expect(first!.hidden).toBeTrue();
  });

  test('getSystemMessages returns all system messages', () => {
    let c = createConversation();
    expect(getSystemMessages(c).length).toBe(0);

    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'system', content: 's1' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 's2' },
      { role: 'system', content: 's3', hidden: true },
    );

    const systemMsgs = getSystemMessages(c);
    expect(systemMsgs.length).toBe(3);
    expect(systemMsgs[0]!.content).toBe('s1');
    expect(systemMsgs[1]!.content).toBe('s2');
    expect(systemMsgs[2]!.content).toBe('s3');
    expect(systemMsgs[2]!.hidden).toBeTrue();
  });

  test('prependSystemMessage adds message at position 0', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    );

    c = prependSystemMessage(c, 'system prompt', { key: 'value' });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('system prompt');
    expect(messages[0]!.position).toBe(0);
    expect(messages[0]!.metadata.key).toBe('value');

    // Check positions were renumbered
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.position).toBe(2);
  });

  test('prependSystemMessage to empty conversation', () => {
    let c = createConversation();
    c = prependSystemMessage(c, 'first');

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('first');
    expect(messages[0]!.position).toBe(0);
  });

  test('prependSystemMessage preserves immutability', () => {
    const c1 = createConversation();
    const c2 = appendUserMessage(c1, 'u');
    const c3 = prependSystemMessage(c2, 's');

    const c2Messages = getOrderedMessages(c2);
    const c3Messages = getOrderedMessages(c3);
    expect(c2Messages.length).toBe(1);
    expect(c3Messages.length).toBe(2);
    expect(c2Messages[0]!.position).toBe(0);
    expect(c3Messages[0]!.role).toBe('system');
  });

  test('replaceSystemMessage replaces first system message', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'old', metadata: { v: 1 } },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'another' },
    );

    const originalId = getOrderedMessages(c)[0]!.id;
    c = replaceSystemMessage(c, 'new system prompt', { v: 2 });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.id).toBe(originalId);
    expect(messages[0]!.content).toBe('new system prompt');
    expect(messages[0]!.metadata.v).toBe(2);
    expect(messages[2]!.content).toBe('another'); // Second system message unchanged
  });

  test('replaceSystemMessage preserves original metadata when not provided', () => {
    let c = createConversation();
    c = appendSystemMessage(c, 'old', { foo: 'bar', num: 42 });

    c = replaceSystemMessage(c, 'new');

    const messages = getOrderedMessages(c);
    expect(messages[0]!.content).toBe('new');
    expect(messages[0]!.metadata.foo).toBe('bar');
    expect(messages[0]!.metadata.num).toBe(42);
  });

  test('replaceSystemMessage prepends when no system message exists', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    );

    c = replaceSystemMessage(c, 'new system', { k: 'v' });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('new system');
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.position).toBe(2);
  });

  test('collapseSystemMessages with no system messages returns same conversation', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    );

    const collapsed = collapseSystemMessages(c);
    expect(collapsed).toBe(c); // Should be same reference if no changes
  });

  test('collapseSystemMessages with one system message returns same conversation', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    );

    const collapsed = collapseSystemMessages(c);
    expect(collapsed).toBe(c);
  });

  test('collapseSystemMessages combines multiple system messages', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'second' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 'third' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3); // 1 system + user + assistant
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('first\nsecond\nthird');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('assistant');

    // Check positions are renumbered
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.position).toBe(2);
  });

  test('collapseSystemMessages deduplicates exact content', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'same' },
      { role: 'system', content: 'different' },
      { role: 'system', content: 'same' },
      { role: 'system', content: 'another' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('same\ndifferent\nanother');
  });

  test('collapseSystemMessages includes hidden messages', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'visible' },
      { role: 'system', content: 'hidden', hidden: true },
      { role: 'user', content: 'u' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(2);
    expect(messages[0]!.content).toBe('visible\nhidden');
  });

  test('collapseSystemMessages flattens multi-modal content to text', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Rules:' },
          { type: 'image', url: 'https://example.com/image.png', text: 'diagram' },
        ],
      },
      { role: 'system', content: 'Second' },
    );

    c = collapseSystemMessages(c);

    expect(getOrderedMessages(c)[0]!.content).toBe('Rules:\nSecond');
  });

  test('collapseSystemMessages preserves first system message properties', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first', metadata: { key: 'value' }, hidden: true },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'u' },
    );

    const originalId = getOrderedMessages(c)[0]!.id;
    const originalCreatedAt = getOrderedMessages(c)[0]!.createdAt;

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages[0]!.id).toBe(originalId);
    expect(messages[0]!.createdAt).toBe(originalCreatedAt);
    expect(messages[0]!.metadata.key).toBe('value');
    expect(messages[0]!.hidden).toBeTrue();
  });

  test('collapseSystemMessages handles empty content correctly', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first' },
      { role: 'system', content: '' },
      { role: 'system', content: 'second' },
    );

    c = collapseSystemMessages(c);

    // Empty content should be filtered out
    expect(getOrderedMessages(c)[0]!.content).toBe('first\nsecond');
  });

  test('mutation operations return new conversation instances', () => {
    const c1 = createConversation();
    const c2 = prependSystemMessage(c1, 'test');
    const c3 = replaceSystemMessage(c2, 'replaced');
    const c4 = appendSystemMessage(c3, 'another');
    const c5 = collapseSystemMessages(c4);

    // Verify immutability - each operation returns a new instance
    expect(c2).not.toBe(c1);
    expect(c3).not.toBe(c2);
    expect(c4).not.toBe(c3);
    expect(c5).not.toBe(c4);

    // Verify updatedAt is set and valid
    expect(c2.updatedAt).toBeDefined();
    expect(c3.updatedAt).toBeDefined();
    expect(c5.updatedAt).toBeDefined();
    expect(new Date(c2.updatedAt).toISOString()).toBe(c2.updatedAt);
  });
});
