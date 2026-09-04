import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import {
  createConversationHistory as createConversation,
  withEnvironment,
} from '../src/conversation';
import {
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
  simpleTokenEstimator,
} from '../src/environment';

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

describe('resolveConversationEnvironment runtime seam (AB-321)', () => {
  it('reads now/randomId through an explicit runtime when none of now/randomId are overridden', () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });

    const environment = resolveConversationEnvironment({ runtime });

    expect(environment.now()).toBe('2030-01-01T00:00:00.000Z');
    expect(environment.randomId()).toBe('conversation-1');
    expect(environment.randomId()).toBe('conversation-2');
  });

  it('lets an explicit now/randomId override win over a supplied runtime', () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });

    const environment = resolveConversationEnvironment({
      runtime,
      now: () => 'explicit-now',
      randomId: () => 'explicit-id',
    });

    expect(environment.now()).toBe('explicit-now');
    expect(environment.randomId()).toBe('explicit-id');
  });

  it('produces byte-identical ids and timestamps from two independently seeded runtimes with the same seeds', () => {
    const runtimeA = createManualRuntimeServices({
      origin: '2030-06-15T12:00:00.000Z',
      identifierSeed: 'seed-a',
    });
    const runtimeB = createManualRuntimeServices({
      origin: '2030-06-15T12:00:00.000Z',
      identifierSeed: 'seed-a',
    });

    const environmentA = resolveConversationEnvironment({ runtime: runtimeA });
    const environmentB = resolveConversationEnvironment({ runtime: runtimeB });

    expect(environmentA.randomId()).toBe(environmentB.randomId());
    expect(environmentA.now()).toBe(environmentB.now());
  });

  it('defaults to a real-globals runtime when no runtime and no now/randomId are supplied', () => {
    const environment = resolveConversationEnvironment();

    expect(typeof environment.now()).toBe('string');
    expect(typeof environment.randomId()).toBe('string');
    expect(environment.randomId()).not.toBe(environment.randomId());
  });
});

describe('isConversationEnvironmentParameter runtime recognition (AB-321)', () => {
  it('recognizes a runtime-only partial environment', () => {
    const runtime = createManualRuntimeServices();

    expect(isConversationEnvironmentParameter({ runtime })).toBe(true);
  });

  it('does not mistake an unrelated object carrying a "runtime" key for an environment', () => {
    expect(isConversationEnvironmentParameter({ runtime: 'production' })).toBe(false);
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
