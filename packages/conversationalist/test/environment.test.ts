import { describe, expect, it } from 'bun:test';

import {
  createConversationHistory as createConversation,
  withEnvironment,
} from '../src/conversation';
import { simpleTokenEstimator } from '../src/environment';

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

describe('simpleTokenEstimator', () => {
  it('counts structural multimodal payloads toward token estimates', () => {
    const tokenCount = simpleTokenEstimator({
      id: 'message-1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
        { type: 'redacted_thinking', data: 'encrypted' },
        { type: 'server_tool_use', id: 'tool-1', name: 'search', input: { query: 'cats' } },
        { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: [{ title: 'Cats' }] },
        { type: 'code_execution_tool_result', tool_use_id: 'tool-2', content: { stdout: 'ok' } },
        {
          type: 'bash_code_execution_tool_result',
          tool_use_id: 'tool-3',
          content: { stdout: 'bash' },
        },
        {
          type: 'text_editor_code_execution_tool_result',
          tool_use_id: 'tool-4',
          content: { path: 'file.txt' },
        },
        {
          type: 'web_fetch_tool_result',
          tool_use_id: 'tool-5',
          content: { url: 'https://e.test' },
        },
        { type: 'container_upload', file_id: 'file-1' },
      ],
      position: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });

    expect(tokenCount).toBeGreaterThan(20);
  });
});
