import { describe, expect, it } from 'bun:test';

import { createConversation, withEnvironment } from '../src';

describe('withEnvironment', () => {
  it('should bind environment to createConversation', () => {
    const customEnv = {
      randomId: () => 'fixed-id',
      now: () => '2024-01-01T00:00:00.000Z',
    };

    const myCreateConversation = withEnvironment(customEnv, createConversation);
    const conversation = myCreateConversation({ title: 'Test' });

    expect(conversation.id).toBe('fixed-id');
    expect(conversation.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(conversation.title).toBe('Test');
  });

  it('should work with other functions that accept environment as last argument', () => {
    const customEnv = {
      randomId: () => 'fixed-id',
    };

    const mockFn = (a: string, b: number, env?: any) => ({ a, b, id: env?.randomId?.() });
    const boundMockFn = withEnvironment(customEnv, mockFn);

    const result = boundMockFn('hello', 42);
    expect(result).toEqual({ a: 'hello', b: 42, id: 'fixed-id' });
  });
});
