import { describe, expect, test } from 'bun:test';

import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
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

  test('materializeToolResults synchronously materializes an array of tool results', () => {
    const results = materializeToolResults([{ callId: 'c1', outcome: 'success', content: 'text' }]);

    expect(results).toEqual([{ callId: 'c1', outcome: 'success', content: 'text' }]);
  });

  test('normalizeJSONValue coerces undefined content to null', () => {
    const result = materializeToolResult({
      callId: 'c2',
      outcome: 'success',
      content: undefined as any,
    });

    expect(result.content).toBe(null);
  });

  test('normalizeJSONValue replaces non-finite numbers with null via JSON round-trip', () => {
    const result = materializeToolResult({
      callId: 'c3',
      outcome: 'success',
      content: { value: Infinity } as any,
    });

    expect(result.content).toEqual({ value: null });
  });

  test('normalizeJSONValue drops symbol-valued properties via JSON round-trip', () => {
    const result = materializeToolResult({
      callId: 'c4',
      outcome: 'success',
      content: { tag: Symbol('test') } as any,
    });

    expect(result.content).toEqual({});
  });

  test('normalizeJSONValue falls back to String() for bare symbols', () => {
    const result = materializeToolResult({
      callId: 'c5',
      outcome: 'success',
      content: Symbol('fallback') as any,
    });

    expect(result.content).toBe('Symbol(fallback)');
  });

  test('normalizeJSONValue falls back to String() for circular arrays', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);

    const result = materializeToolResult({
      callId: 'c6',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe(String(circular));
  });

  test('normalizeJSONValue falls back to String() for circular objects', () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    const result = materializeToolResult({
      callId: 'c7',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe(String(circular));
  });
});
