import { describe, expect, test } from 'bun:test';

import type { Conversation, Message } from '../../src/types';
import {
  isTransientKey,
  stripTransientFromRecord,
  stripTransientMetadata,
} from '../../src/utilities/transient';

type ConversationOverrides = Partial<Omit<Conversation, 'messages' | 'ids'>> & {
  messages?: Message[];
  ids?: string[];
};

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const toMessageRecord = (messages: Message[]): Record<string, Message> =>
  messages.reduce<Record<string, Message>>((acc, message) => {
    acc[message.id] = message;
    return acc;
  }, {});

describe('transient utilities', () => {
  describe('isTransientKey', () => {
    test('returns true for keys starting with underscore', () => {
      expect(isTransientKey('_temp')).toBe(true);
      expect(isTransientKey('_')).toBe(true);
      expect(isTransientKey('__internal')).toBe(true);
      expect(isTransientKey('_deliveryStatus')).toBe(true);
    });

    test('returns false for keys not starting with underscore', () => {
      expect(isTransientKey('source')).toBe(false);
      expect(isTransientKey('id')).toBe(false);
      expect(isTransientKey('')).toBe(false);
      expect(isTransientKey('temp_value')).toBe(false);
    });
  });

  describe('stripTransientFromRecord', () => {
    test('removes keys starting with underscore', () => {
      const input = { _temp: 1, source: 'web', _internal: true };
      const result = stripTransientFromRecord(input);
      expect(result).toEqual({ source: 'web' });
    });

    test('returns empty object when all keys are transient', () => {
      const input = { _a: 1, _b: 2, _c: 3 };
      const result = stripTransientFromRecord(input);
      expect(result).toEqual({});
    });

    test('returns same data when no keys are transient', () => {
      const input = { source: 'web', type: 'chat', count: 5 };
      const result = stripTransientFromRecord(input);
      expect(result).toEqual(input);
    });

    test('handles empty object', () => {
      const input = {};
      const result = stripTransientFromRecord(input);
      expect(result).toEqual({});
    });

    test('preserves nested objects', () => {
      const input = { _temp: 1, nested: { a: 1, b: 2 } };
      const result = stripTransientFromRecord(input);
      expect(result).toEqual({ nested: { a: 1, b: 2 } });
    });
  });

  describe('stripTransientMetadata', () => {
    const createConversation = (overrides: ConversationOverrides = {}): Conversation => {
      const { messages = [], ids, ...rest } = overrides;
      const baseIds = ids ?? messages.map((message) => message.id);

      return {
        schemaVersion: 1,
        id: 'conv-1',
        status: 'active',
        metadata: {},
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
        ...rest,
        messages: toMessageRecord(messages),
        ids: baseIds,
      };
    };

    test('strips transient metadata from conversation', () => {
      const conversation = createConversation({
        metadata: { _tempState: 'loading', source: 'web' },
      });

      const result = stripTransientMetadata(conversation);

      expect(result.metadata).toEqual({ source: 'web' });
      expect(result.metadata).not.toHaveProperty('_tempState');
    });

    test('strips transient metadata from messages', () => {
      const conversation = createConversation({
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            position: 0,
            createdAt: '2024-01-15T10:00:00.000Z',
            metadata: { _deliveryStatus: 'sent', source: 'keyboard' },
            hidden: false,
          },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'Hi there!',
            position: 1,
            createdAt: '2024-01-15T10:01:00.000Z',
            metadata: { _processingTime: 100, model: 'gpt-4' },
            hidden: false,
          },
        ],
      });

      const result = stripTransientMetadata(conversation);

      const ordered = getOrderedMessages(result);
      expect(ordered[0]?.metadata).toEqual({ source: 'keyboard' });
      expect(ordered[1]?.metadata).toEqual({ model: 'gpt-4' });
    });

    test('preserves all other conversation fields', () => {
      const conversation = createConversation({
        id: 'test-conv',
        title: 'Test Conversation',
        status: 'archived',
        metadata: { _temp: 1, permanent: 'value' },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Test',
            position: 0,
            createdAt: '2024-01-15T10:00:00.000Z',
            metadata: {},
            hidden: false,
            tokenUsage: { prompt: 10, completion: 20, total: 30 },
          },
        ],
      });

      const result = stripTransientMetadata(conversation);

      expect(result.id).toBe('test-conv');
      expect(result.title).toBe('Test Conversation');
      expect(result.status).toBe('archived');
      expect(getOrderedMessages(result)[0]?.content).toBe('Test');
      expect(getOrderedMessages(result)[0]?.tokenUsage).toEqual({
        prompt: 10,
        completion: 20,
        total: 30,
      });
    });

    test('handles empty conversation', () => {
      const conversation = createConversation();
      const result = stripTransientMetadata(conversation);

      expect(result.metadata).toEqual({});
      expect(result.ids).toEqual([]);
      expect(result.messages).toEqual({});
    });

    test('preserves toolCall and toolResult on messages', () => {
      const conversation = createConversation({
        messages: [
          {
            id: 'msg-1',
            role: 'tool-use',
            content: '',
            position: 0,
            createdAt: '2024-01-15T10:00:00.000Z',
            metadata: { _temp: 1 },
            hidden: false,
            toolCall: { id: 'call-1', name: 'search', arguments: '{}' },
          },
          {
            id: 'msg-2',
            role: 'tool-result',
            content: 'Result',
            position: 1,
            createdAt: '2024-01-15T10:01:00.000Z',
            metadata: { _temp: 2 },
            hidden: false,
            toolResult: { callId: 'call-1', outcome: 'success', content: 'Success' },
          },
        ],
      });

      const result = stripTransientMetadata(conversation);

      expect(getOrderedMessages(result)[0]?.toolCall).toEqual({
        id: 'call-1',
        name: 'search',
        arguments: '{}',
      });
      expect(getOrderedMessages(result)[1]?.toolResult).toEqual({
        callId: 'call-1',
        outcome: 'success',
        content: 'Success',
      });
    });
  });
});
