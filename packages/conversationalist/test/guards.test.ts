import { describe, expect, test } from 'bun:test';

import {
  isConversation,
  isConversationHistory,
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
import { Conversation } from '../src/history';
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

  test('isConversationHistory recognizes valid conversations', () => {
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

    expect(isConversationHistory(conversation)).toBeTrue();
    expect(isConversationHistory({})).toBeFalse();
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
    expect(
      isTokenUsage({
        prompt: 1,
        completion: 2,
        total: 3,
        cacheCreationTokens: 5,
        cacheReadTokens: 10,
      }),
    ).toBeTrue();
    expect(isTokenUsage({ prompt: 1, completion: 2, total: 3, cacheReadTokens: -1 })).toBeFalse();
    expect(isMultiModalContent({ type: 'text', text: 'hello' })).toBeTrue();
    expect(isMultiModalContent({ type: 'image' })).toBeFalse();
    expect(isJSONValue({ ok: [true, 1, 'two'] })).toBeTrue();
    expect(isJSONValue(undefined)).toBeFalse();
  });

  describe('isConversation', () => {
    test('returns false for null', () => {
      expect(isConversation(null)).toBeFalse();
    });

    test('returns false for primitives', () => {
      expect(isConversation(42)).toBeFalse();
      expect(isConversation('string')).toBeFalse();
      expect(isConversation(undefined)).toBeFalse();
    });

    test('returns false for an empty object', () => {
      expect(isConversation({})).toBeFalse();
    });

    test('returns false for a partial duck-type missing some methods', () => {
      const partial = {
        appendAssistantMessage: () => {},
        appendToolCalls: () => {},
        // missing appendToolResults and current
      };
      expect(isConversation(partial)).toBeFalse();
    });

    test('returns true for a real Conversation instance', () => {
      const conversation = new Conversation();
      expect(isConversation(conversation)).toBeTrue();
    });

    test('returns true for a plain object with all required properties', () => {
      const duckTyped = {
        appendAssistantMessage: () => {},
        appendToolCalls: () => {},
        appendToolResults: () => {},
        current: {},
      };
      expect(isConversation(duckTyped)).toBeTrue();
    });
  });
});
