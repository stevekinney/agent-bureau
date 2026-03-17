import { describe, expect, test } from 'bun:test';

import type { Message } from '../../src/types';
import { pairToolCallsWithResults } from '../../src/utilities/tool-calls';

describe('tool call pairing', () => {
  const createMessage = (overrides: Partial<Message>): Message => ({
    id: 'msg-1',
    role: 'user',
    content: '',
    position: 0,
    createdAt: new Date().toISOString(),
    metadata: {},
    hidden: false,
    ...overrides,
  });

  test('returns empty array for messages without tool calls', () => {
    const messages: Message[] = [
      createMessage({ id: 'msg-1', role: 'user', content: 'Hello' }),
      createMessage({ id: 'msg-2', role: 'assistant', content: 'Hi there' }),
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs).toEqual([]);
  });

  test('pairs tool calls with their results', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        role: 'tool-use',
        toolCall: { id: 'call-1', name: 'search', arguments: { query: 'test' } },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-result',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'Found results' },
      }),
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.id).toBe('call-1');
    expect(pairs[0].call.name).toBe('search');
    expect(pairs[0].result?.outcome).toBe('success');
    expect(pairs[0].result?.content).toBe('Found results');
  });

  test('handles tool calls without results (pending)', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        role: 'tool-use',
        toolCall: { id: 'call-1', name: 'search', arguments: {} },
      }),
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.id).toBe('call-1');
    expect(pairs[0].result).toBeUndefined();
  });

  test('handles multiple tool calls with mixed results', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        role: 'tool-use',
        toolCall: { id: 'call-1', name: 'search', arguments: {} },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-use',
        toolCall: { id: 'call-2', name: 'fetch', arguments: {} },
      }),
      createMessage({
        id: 'msg-3',
        role: 'tool-result',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'Result 1' },
      }),
      // call-2 has no result yet
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].call.id).toBe('call-1');
    expect(pairs[0].result?.content).toBe('Result 1');
    expect(pairs[1].call.id).toBe('call-2');
    expect(pairs[1].result).toBeUndefined();
  });

  test('handles results that arrive before their calls in message order', () => {
    // This can happen if messages are not strictly ordered
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        role: 'tool-result',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'Result' },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-use',
        toolCall: { id: 'call-1', name: 'search', arguments: {} },
      }),
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.id).toBe('call-1');
    expect(pairs[0].result?.content).toBe('Result');
  });

  test('preserves order of tool calls', () => {
    const messages: Message[] = [
      createMessage({
        id: 'msg-1',
        role: 'tool-use',
        toolCall: { id: 'call-a', name: 'first', arguments: {} },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-use',
        toolCall: { id: 'call-b', name: 'second', arguments: {} },
      }),
      createMessage({
        id: 'msg-3',
        role: 'tool-use',
        toolCall: { id: 'call-c', name: 'third', arguments: {} },
      }),
    ];

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs.map((p) => p.call.name)).toEqual(['first', 'second', 'third']);
  });

  test('accepts message records and orders by position', () => {
    const messages: Record<string, Message> = {
      a: createMessage({
        id: 'a',
        role: 'tool-use',
        position: 1,
        toolCall: { id: 'call-1', name: 'alpha', arguments: {} },
      }),
      b: createMessage({
        id: 'b',
        role: 'tool-use',
        position: 0,
        toolCall: { id: 'call-2', name: 'beta', arguments: {} },
      }),
    };

    const pairs = pairToolCallsWithResults(messages);
    expect(pairs.map((pair) => pair.call.name)).toEqual(['beta', 'alpha']);
  });
});
