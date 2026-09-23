import { describe, expect, it } from 'bun:test';

import { formatOpenAIToolResults, formatOpenAIToolResultsAsync } from './index';

describe('formatOpenAIToolResults', () => {
  it('formats single result', () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: 'result',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: 'result',
    };
    const messages = formatOpenAIToolResults(result);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result',
      },
    ]);
  });

  it('formats multiple results', () => {
    const results = [
      {
        callId: 'call_1',
        outcome: 'success' as const,
        content: 'result1',
        toolCallId: 'call_1',
        toolName: 'tool1',
        result: 'result1',
      },
      {
        callId: 'call_2',
        outcome: 'success' as const,
        content: { foo: 'bar' },
        toolCallId: 'call_2',
        toolName: 'tool2',
        result: { foo: 'bar' },
      },
    ];
    const messages = formatOpenAIToolResults(results);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result1',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '{"foo":"bar"}',
      },
    ]);
  });

  it('throws for streaming results', () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: {
        async *[Symbol.asyncIterator]() {
          yield 'a';
        },
      },
      stream: {
        async *[Symbol.asyncIterator]() {
          yield 'a';
        },
      },
    };

    expect(() => formatOpenAIToolResults(result)).toThrow(
      'formatOpenAIToolResults does not support streaming results. Use formatOpenAIToolResultsAsync or execute without { stream: true }.',
    );
  });
});

describe('formatOpenAIToolResultsAsync', () => {
  it('formats non-streaming results without collection', async () => {
    const result = {
      callId: 'call_plain',
      outcome: 'success' as const,
      content: { ok: true },
      toolCallId: 'call_plain',
      toolName: 'tool-plain',
      result: { ok: true },
    };

    const messages = await formatOpenAIToolResultsAsync(result);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_plain',
        content: '{"ok":true}',
      },
    ]);
  });

  it('formats streaming results by collecting chunks', async () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: {
        async *[Symbol.asyncIterator]() {
          yield { token: 'a' };
          yield { token: 'b' };
        },
      },
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { token: 'a' };
          yield { token: 'b' };
        },
      },
    };

    const messages = await formatOpenAIToolResultsAsync(result);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '[{"token":"a"},{"token":"b"}]',
      },
    ]);
  });

  it('collects chunks from result when stream handle is absent', async () => {
    const result = {
      callId: 'call_2',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_2',
      toolName: 'tool2',
      result: {
        async *[Symbol.asyncIterator]() {
          yield 'x';
          yield 'y';
        },
      },
    };

    const messages = await formatOpenAIToolResultsAsync(result);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '["x","y"]',
      },
    ]);
  });
});
