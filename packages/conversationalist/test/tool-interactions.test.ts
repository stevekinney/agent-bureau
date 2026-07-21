import { describe, expect, it } from 'bun:test';

import {
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  createConversationHistory as createConversation,
  deserializeConversationHistory,
  getPendingToolCalls,
  getToolInteractions,
  materializeToolCall,
  materializeToolResult,
  materializeToolResultAsync,
  resolveToolResult,
} from '../src/conversation/index';
import { conversationSchema } from '../src/schemas';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `call-${++counter}`;
  })(),
};

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('tool interaction helpers', () => {
  it('appends tool-call and tool-result messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      arguments: { input: 'value' },
    });
    const callId = getOrderedMessages(conv)[0]?.toolCall?.id;
    expect(callId).toBeDefined();

    conv = appendToolResult(conv, {
      callId: callId!,
      outcome: 'success',
      content: { ok: true },
    });

    const messages = getOrderedMessages(conv);
    expect(messages[0]?.role).toBe('tool-call');
    expect(messages[1]?.role).toBe('tool-result');
  });

  it('returns pending tool calls without results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call-1');
  });

  it('returns no pending calls after results are recorded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(0);
  });

  it('pairs tool calls with results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    });

    const interactions = getToolInteractions(conv);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.call.id).toBe('call-1');
    expect(interactions[0]?.result?.outcome).toBe('success');
  });

  it('generates call IDs when omitted', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      {
        name: 'tool',
        arguments: { input: 'value' },
      },
      undefined,
      testEnvironment,
    );

    const [message] = getOrderedMessages(conv);
    expect(message?.toolCall?.id).toBe('call-1');
  });

  it('materializes tool calls with a shared ID generator interface', () => {
    expect(
      materializeToolCall(
        {
          name: 'tool',
          arguments: { value: 1 },
        },
        {
          generateId: () => 'materialized-call',
        },
      ),
    ).toEqual({
      id: 'materialized-call',
      name: 'tool',
      arguments: { value: 1 },
    });
  });

  it('rejects tool results without a matching tool call', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(() =>
      appendToolResult(
        conv,
        {
          callId: 'missing',
          outcome: 'success',
          content: { ok: true },
        },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('appends batches of tool calls in order', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCalls(
      conv,
      [
        { id: 'call-1', name: 'search', arguments: { query: 'alpha' } },
        { id: 'call-2', name: 'search', arguments: { query: 'beta' } },
      ],
      testEnvironment,
    );

    const messages = getOrderedMessages(conv);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.toolCall?.id).toBe('call-1');
    expect(messages[1]?.toolCall?.id).toBe('call-2');
  });

  it('returns the original conversation for empty tool-call batches', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(appendToolCalls(conv, [], testEnvironment)).toBe(conv);
  });

  it('collects streamed tool results before persisting them', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      id: 'call-1',
      name: 'tool',
      arguments: { input: 'value' },
    });

    conv = await appendToolResultAsync(
      conv,
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { chunk: 'a' };
            yield { chunk: 'b' };
          },
        },
      },
      undefined,
      testEnvironment,
    );

    const messages = getOrderedMessages(conv);
    expect(messages[1]?.toolResult?.content).toEqual([{ chunk: 'a' }, { chunk: 'b' }]);
  });

  it('collects batches of streamed armorer-style tool results', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCalls(
      conv,
      [
        { id: 'call-1', name: 'tool', arguments: { index: 1 } },
        { id: 'call-2', name: 'tool', arguments: { index: 2 } },
      ],
      testEnvironment,
    );

    conv = await appendToolResultsAsync(
      conv,
      [
        {
          callId: 'call-1',
          outcome: 'success',
          content: [],
          result: {
            async *[Symbol.asyncIterator]() {
              yield 'alpha';
              yield 'beta';
            },
          },
        },
        {
          callId: 'call-2',
          outcome: 'error',
          content: [],
          stream: {
            async *[Symbol.asyncIterator]() {
              yield { code: 'denied' };
            },
          },
          error: {
            code: 'tool.denied',
            category: 'permission',
            retryable: false,
            message: 'Denied',
          },
        },
      ],
      testEnvironment,
    );

    const messages = getOrderedMessages(conv);
    expect(messages[2]?.toolResult?.content).toEqual(['alpha', 'beta']);
    expect(messages[3]?.toolResult?.content).toEqual([{ code: 'denied' }]);
    expect(messages[3]?.toolResult?.error?.category).toBe('permission');
  });

  it('returns the original conversation for empty tool-result batches', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(appendToolResults(conv, [], testEnvironment)).toBe(conv);
  });

  it('returns the original conversation for empty async tool-result batches', async () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(await appendToolResultsAsync(conv, [], testEnvironment)).toBe(conv);
  });

  it('rejects streamed tool results in the synchronous helper', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);

    expect(() =>
      appendToolResult(conv, {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      }),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });

  it('normalizes materialized tool-result payload details to JSON-safe values', () => {
    expect(
      materializeToolResult({
        callId: 'call-1',
        outcome: 'action_required',
        content: { allowed: true },
        action: {
          type: 'approval',
          schema: { approved: true },
        },
        error: {
          code: 'TOOL_ERROR',
          category: 'internal',
          retryable: false,
          message: 'Failure',
          details: { retryAfterSeconds: 5 },
        },
      }),
    ).toEqual({
      callId: 'call-1',
      outcome: 'action_required',
      content: { allowed: true },
      action: {
        type: 'approval',
        schema: { approved: true },
      },
      error: {
        code: 'TOOL_ERROR',
        category: 'internal',
        retryable: false,
        message: 'Failure',
        details: { retryAfterSeconds: 5 },
      },
    });
  });

  it('materializes non-streaming tool results asynchronously without runtime fields', async () => {
    expect(
      await materializeToolResultAsync({
        callId: 'call-async',
        outcome: 'action_required',
        content: undefined,
        action: {
          type: 'approval',
          schema: Symbol('schema'),
        },
        result: 'ignored runtime payload',
      }),
    ).toEqual({
      callId: 'call-async',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        schema: 'Symbol(schema)',
      },
    });
  });

  it('stringifies non-serializable asynchronous tool-result payloads', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(
      await materializeToolResultAsync({
        callId: 'call-circular',
        outcome: 'error',
        content: circular,
        error: {
          code: 'tool.circular',
          category: 'internal',
          retryable: false,
          message: 'circular',
          details: circular,
        },
      }),
    ).toEqual({
      callId: 'call-circular',
      outcome: 'error',
      content: '[object Object]',
      error: {
        code: 'tool.circular',
        category: 'internal',
        retryable: false,
        message: 'circular',
        details: '[object Object]',
      },
    });
  });

  it('preserves primitive content when materializing tool results asynchronously', async () => {
    expect(
      await materializeToolResultAsync({
        callId: 'call-primitive',
        outcome: 'success',
        content: 42,
      }),
    ).toEqual({
      callId: 'call-primitive',
      outcome: 'success',
      content: 42,
    });
  });
});

describe('resolveToolResult', () => {
  const buildPendingConversation = (): Conversation => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'deploy', arguments: { environment: 'production' } },
      undefined,
      testEnvironment,
    );
    conv = appendToolResult(
      conv,
      {
        callId: 'call-1',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval', message: 'Approve deploy to production?' },
      },
      undefined,
      testEnvironment,
    );
    return conv;
  };

  it('replaces a pending tool-result with the resolved result, yielding exactly one tool-result for that callId', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    const toolResultMessages = getOrderedMessages(resolved).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
    expect(toolResultMessages[0]?.toolResult?.content).toEqual({ deployed: true });
  });

  it('preserves the original message id, createdAt, and position', () => {
    const conv = buildPendingConversation();
    const pending = getOrderedMessages(conv).find((message) => message.role === 'tool-result');
    expect(pending).toBeDefined();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );
    const replaced = getOrderedMessages(resolved).find((message) => message.role === 'tool-result');

    expect(replaced?.id).toBe(pending!.id);
    expect(replaced?.createdAt).toBe(pending!.createdAt);
    expect(replaced?.position).toBe(pending!.position);
  });

  it('works identically on a Conversation rehydrated from serialized JSON', () => {
    const conv = buildPendingConversation();

    // Round-trip through JSON, exactly as a stateless host reconstructing a
    // conversation from persisted storage would.
    const rehydrated = deserializeConversationHistory(JSON.parse(JSON.stringify(conv)));

    const resolved = resolveToolResult(
      rehydrated,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    const toolResultMessages = getOrderedMessages(resolved).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
  });

  it('produces a schema-valid history with coherent ids and positions', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    expect(conversationSchema.safeParse(resolved).success).toBe(true);
    expect(resolved.ids).toEqual(conv.ids);
    resolved.ids.forEach((id, index) => {
      expect(resolved.messages[id]?.position).toBe(index);
    });
  });

  it('throws when no tool-result message exists for the callId', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);

    expect(() =>
      resolveToolResult(
        conv,
        'missing-call',
        { callId: 'missing-call', outcome: 'success', content: {} },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('throws when the callId has no pending tool-result but a tool-call exists', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'deploy', arguments: {} },
      undefined,
      testEnvironment,
    );

    expect(() =>
      resolveToolResult(
        conv,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: {} },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('overrides content, metadata, hidden, and tokenUsage via options while defaulting to the original values otherwise', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      { content: 'Deploy approved.', metadata: { approvedBy: 'user-1' }, hidden: true },
      testEnvironment,
    );

    const replaced = getOrderedMessages(resolved).find((message) => message.role === 'tool-result');
    expect(replaced?.content).toBe('Deploy approved.');
    expect(replaced?.metadata).toEqual({ approvedBy: 'user-1' });
    expect(replaced?.hidden).toBe(true);
  });
});
