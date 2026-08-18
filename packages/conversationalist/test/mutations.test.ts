import { describe, expect, it } from 'bun:test';

import {
  appendAssistantMessage,
  appendMessages,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import type { AssistantMessage, ConversationHistory, ToolResult } from '../src/types';

const environment = {
  now: () => '2026-08-18T12:00:00.000Z',
  randomId: (() => {
    let nextId = 0;
    return () => `message-${++nextId}`;
  })(),
};

const expectValid = (history: ConversationHistory): void => {
  expect(validateConversationHistoryIntegrity(history)).toEqual([]);
};

describe('immutable transcript mutations', () => {
  it('updates editable message fields while preserving identity and the input history', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'assistant',
        content: 'Original',
        metadata: { source: 'seed' },
        goalCompleted: true,
      },
      environment,
    );
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId] as AssistantMessage;
    const originalSnapshot = structuredClone(history);
    const updates = {
      content: [{ type: 'text' as const, text: 'Updated' }],
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    };

    const updated = updateMessage(history, messageId, updates, environment);

    expect(updated).not.toBe(history);
    expect(updated.messages[messageId]).toMatchObject({
      id: originalMessage.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'Updated' }],
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    });
    expect((updated.messages[messageId] as AssistantMessage).goalCompleted).toBeTrue();
    expect(updated.updatedAt).toBe(environment.now());
    expect(history).toEqual(originalSnapshot);
    expect(history.messages[messageId]).toBe(originalMessage);
    const updatedNestedMetadata = updated.messages[messageId]?.metadata.nested;
    expect(updatedNestedMetadata).not.toBe(updates.metadata.nested);
    expectValid(updated);
  });

  it('returns the original history when updating an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(updateMessage(history, 'missing', { content: 'No change' }, environment)).toBe(history);
  });

  it('removes a message and restores contiguous positions without mutating survivors', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'First', undefined, environment);
    history = appendAssistantMessage(history, 'Remove me', undefined, environment);
    history = appendUserMessage(history, 'Third', undefined, environment);
    const [firstId, removedId, thirdId] = history.ids as [string, string, string];
    const firstMessage = history.messages[firstId]!;
    const thirdMessage = history.messages[thirdId]!;
    const originalSnapshot = structuredClone(history);

    const updated = removeMessage(history, removedId, environment);

    expect(updated.ids).toEqual([firstId, thirdId]);
    expect(updated.messages[removedId]).toBeUndefined();
    expect(updated.messages[firstId]).toBe(firstMessage);
    expect(updated.messages[thirdId]).not.toBe(thirdMessage);
    expect(updated.messages[firstId]?.position).toBe(0);
    expect(updated.messages[thirdId]?.position).toBe(1);
    expect(history).toEqual(originalSnapshot);
    expectValid(updated);
  });

  it('returns the original history when removing an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(removeMessage(history, 'missing', environment)).toBe(history);
  });

  it('rejects removal that would leave an orphaned tool result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: null },
      },
      environment,
    );

    expect(() => removeMessage(history, history.ids[0]!, environment)).toThrow(
      ConversationalistError,
    );
    expectValid(history);
  });

  it('sets and clears message visibility without mutating the input message', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Toggle me', undefined, environment);
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId]!;

    const hidden = setMessageHidden(history, messageId, true, environment);
    const visible = setMessageHidden(hidden, messageId, false, environment);

    expect(hidden.messages[messageId]?.hidden).toBeTrue();
    expect(visible.messages[messageId]?.hidden).toBeFalse();
    expect(history.messages[messageId]).toBe(originalMessage);
    expect(originalMessage.hidden).toBeFalse();
    expectValid(hidden);
    expectValid(visible);
  });

  it('returns the original history when hiding an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(setMessageHidden(history, 'missing', true, environment)).toBe(history);
  });

  it('replaces the result for a tool-call identifier without mutating the input result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: { accountId: 'account-1' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[1]!;
    const originalMessage = history.messages[resultMessageId]!;
    const replacement: ToolResult = {
      callId: 'call-1',
      outcome: 'success',
      content: { nested: { status: 'active' } },
    };
    const originalReplacement = structuredClone(replacement);

    const updated = replaceToolResult(history, 'call-1', replacement, environment);

    expect(updated.messages[resultMessageId]).not.toBe(originalMessage);
    expect(updated.messages[resultMessageId]).toMatchObject({
      id: originalMessage.id,
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      toolResult: replacement,
    });
    expect(history.messages[resultMessageId]).toBe(originalMessage);
    expect(replacement).toEqual(originalReplacement);
    expect(updated.messages[resultMessageId]?.toolResult).not.toBe(replacement);
    expectValid(updated);
  });

  it('returns the original history for an unknown tool-call identifier', () => {
    const history = createConversationHistory({}, environment);
    const replacement: ToolResult = {
      callId: 'missing',
      outcome: 'success',
      content: null,
    };

    expect(replaceToolResult(history, 'missing', replacement, environment)).toBe(history);
  });

  it('rejects a replacement whose call identifier does not match the target', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: null },
        environment,
      ),
    ).toThrow(ConversationalistError);
    expectValid(history);
  });
});
