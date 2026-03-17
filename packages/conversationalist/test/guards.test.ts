import { describe, expect, test } from 'bun:test';

import {
  isConversation,
  isConversationStatus,
  isJSONValue,
  isMessage,
  isMessageInput,
  isMessageRole,
  isMultiModalContent,
  isTokenUsage,
  isToolCall,
  isToolResult,
} from '../src/guards';
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

describe('type guards', () => {
  const now = new Date().toISOString();
  const message = {
    id: 'msg-1',
    role: 'user',
    content: 'hi',
    position: 0,
    createdAt: now,
    metadata: {},
    hidden: false,
  } as const;

  test('isConversation recognizes valid conversations', () => {
    const conversation = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      ids: [message.id],
      messages: { [message.id]: message },
      createdAt: now,
      updatedAt: now,
    } as const;

    expect(isConversation(conversation)).toBeTrue();
    expect(isConversation({})).toBeFalse();
  });

  test('isMessage recognizes valid messages', () => {
    expect(isMessage(message)).toBeTrue();
    expect(isMessage({ role: 'user' })).toBeFalse();
  });

  test('isMessageInput recognizes valid input', () => {
    expect(isMessageInput({ role: 'user', content: 'hello' })).toBeTrue();
    expect(isMessageInput({ role: 'user' })).toBeFalse();
  });

  test('tool guards validate tool payloads', () => {
    const toolCall = { id: 'call-1', name: 'search', arguments: { q: 'hi' } };
    const toolResult = {
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    } as const;

    expect(isToolCall(toolCall)).toBeTrue();
    expect(isToolCall({ id: 'call-1' })).toBeFalse();
    expect(isToolResult(toolResult)).toBeTrue();
    expect(isToolResult({ outcome: 'error' })).toBeFalse();
  });

  test('value/enum guards validate primitives', () => {
    expect(isMessageRole('assistant')).toBeTrue();
    expect(isMessageRole('unknown')).toBeFalse();
    expect(isConversationStatus('archived')).toBeTrue();
    expect(isConversationStatus('unknown')).toBeFalse();
    expect(isTokenUsage({ prompt: 1, completion: 2, total: 3 })).toBeTrue();
    expect(isTokenUsage({ prompt: 1 })).toBeFalse();
    expect(isMultiModalContent({ type: 'text', text: 'hello' })).toBeTrue();
    expect(isMultiModalContent({ type: 'image' })).toBeFalse();
    expect(isJSONValue({ ok: [true, 1, 'two'] })).toBeTrue();
    expect(isJSONValue(undefined)).toBeFalse();
  });
});
