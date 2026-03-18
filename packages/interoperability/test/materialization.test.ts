import { describe, expect, test } from 'bun:test';

import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResultsAsync,
} from '../src';

describe('interoperability materialization', () => {
  test('materializes tool calls with generated identifiers and JSON-safe arguments', () => {
    const calls = materializeToolCalls(
      [
        { name: 'weather', arguments: { city: 'Denver' } },
        { id: 'existing-call', name: 'time', arguments: undefined },
      ],
      {
        generateId: () => 'generated-call',
      },
    );

    expect(calls).toEqual([
      {
        id: 'generated-call',
        name: 'weather',
        arguments: { city: 'Denver' },
      },
      {
        id: 'existing-call',
        name: 'time',
        arguments: {},
      },
    ]);
  });

  test('materializes synchronous tool results and strips runtime-only fields', () => {
    const result = materializeToolResult({
      callId: 'call-1',
      outcome: 'error',
      content: { ok: false },
      error: {
        code: 'E_FAIL',
        category: 'internal',
        retryable: false,
        message: 'boom',
        details: new Date('2026-03-18T00:00:00.000Z'),
      },
      action: {
        type: 'input',
        schema: { prompt: 'city' },
      },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
      result: { ignored: true },
    });

    expect(result).toEqual({
      callId: 'call-1',
      outcome: 'error',
      content: { ok: false },
      error: {
        code: 'E_FAIL',
        category: 'internal',
        retryable: false,
        message: 'boom',
        details: '2026-03-18T00:00:00.000Z',
      },
      action: {
        type: 'input',
        schema: { prompt: 'city' },
      },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
    });
  });

  test('rejects synchronous materialization of streaming tool results', () => {
    expect(() =>
      materializeToolResult({
        callId: 'call-1',
        outcome: 'success',
        content: [],
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      }),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });

  test('materializes streamed tool results asynchronously', async () => {
    const result = await materializeToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: 'ignored',
      stream: {
        async *[Symbol.asyncIterator]() {
          yield 'alpha';
          yield { beta: true };
        },
      },
    });

    expect(result).toEqual({
      callId: 'call-1',
      outcome: 'success',
      content: ['alpha', { beta: true }],
    });
  });

  test('materializes batches of tool results asynchronously', async () => {
    const results = await materializeToolResultsAsync([
      {
        callId: 'call-1',
        outcome: 'success',
        content: 'plain',
      },
      {
        callId: 'call-2',
        outcome: 'success',
        content: [],
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      },
    ]);

    expect(results).toEqual([
      {
        callId: 'call-1',
        outcome: 'success',
        content: 'plain',
      },
      {
        callId: 'call-2',
        outcome: 'success',
        content: ['chunk'],
      },
    ]);
  });

  test('materializeToolCall falls back to a random identifier when needed', () => {
    const call = materializeToolCall({
      name: 'search',
      arguments: new Map([['query', 'weather']]),
    });

    expect(typeof call.id).toBe('string');
    expect(call.id.length).toBeGreaterThan(0);
    expect(call.name).toBe('search');
    expect(call.arguments).toEqual({});
  });
});
