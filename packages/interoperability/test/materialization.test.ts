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

  test('closes a streaming iterator when materialization is aborted', async () => {
    const controller = new AbortController();
    let closed = false;
    const materialization = materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              async return() {
                closed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      },
      { signal: controller.signal },
    );

    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(materialization).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true);
  });

  test('materializes a stream successfully while an abort signal remains active', async () => {
    const controller = new AbortController();

    await expect(
      materializeToolResultAsync(
        {
          callId: 'call-1',
          outcome: 'success',
          content: [],
          stream: {
            async *[Symbol.asyncIterator]() {
              yield 'complete';
            },
          },
        },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ content: ['complete'] });
  });

  test('normalizes non-Error abort reasons and iterator rejections', async () => {
    const controller = new AbortController();
    const aborted = materializeToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
          },
        },
      },
      { signal: controller.signal },
    );
    controller.abort('stop');

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      materializeToolResultAsync(
        {
          callId: 'call-2',
          outcome: 'success',
          content: [],
          stream: {
            [Symbol.asyncIterator]() {
              return { next: () => Promise.reject('stream failed') };
            },
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('stream failed');
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

    // Asserted as a literal rather than as `String(circular)`: the expression under test is
    // exactly the one that is unsafe on some engines (Bun >= 1.4 overflows the stack instead of
    // applying join()'s cycle guard), so computing the expectation that way would make this test
    // pass or crash depending on the host rather than on the code.
    expect(result.content).toBe('1,2,');
  });

  test('normalizeJSONValue elides nested and mutual array cycles the same way join does', () => {
    const outer: any[] = ['a'];
    const inner: any[] = ['b', outer];
    outer.push(inner);

    const result = materializeToolResult({
      callId: 'c6-mutual',
      outcome: 'success',
      content: outer as any,
    });

    expect(result.content).toBe('a,b,');
  });

  test('normalizeJSONValue renders a shared but acyclic array reference normally', () => {
    const shared: any[] = [1];
    // The BigInt is what forces the `stringifyNonJSON` path: it makes `JSON.stringify` throw.
    // A function would not, since `JSON.stringify` silently nulls it and the value round-trips.
    const content: any[] = [shared, shared, 1n];

    const result = materializeToolResult({
      callId: 'c6-shared',
      outcome: 'success',
      content: content as any,
    });

    // `shared` appears twice but is never its own ancestor, so neither occurrence is a cycle.
    expect(result.content).toBe('1,1,1');
  });

  test('normalizeJSONValue leaves circular plain objects rendering as [object Object]', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = materializeToolResult({
      callId: 'c6-object',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('[object Object]');
  });

  test('normalizeJSONValue preserves a circular array\'s own toString hook', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // A custom hook is what `String()` actually calls, and it does not recurse the way the
    // default comma-join does, so eliding here would replace real output with a joined clone.
    circular.toString = () => 'custom-array';

    const result = materializeToolResult({
      callId: 'c6-tostring',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('custom-array');
  });

  test('normalizeJSONValue preserves a circular array\'s Symbol.toPrimitive hook', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    Object.defineProperty(circular, Symbol.toPrimitive, {
      value: () => 'primitive-array',
    });

    const result = materializeToolResult({
      callId: 'c6-toprimitive',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('primitive-array');
  });

  test('normalizeJSONValue preserves a circular array\'s overridden join', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // `Array.prototype.toString` delegates to `this.join`, so overriding join is as much a
    // custom coercion hook as overriding toString.
    circular.join = () => 'custom-join';

    const result = materializeToolResult({
      callId: 'c6-join',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('custom-join');
  });

  test('normalizeJSONValue does not dispatch through an input-controlled map', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // An array carrying its own `map` (metadata, or a subclass override) must not be invoked:
    // `String()` never consults `map`, so normalization must not either. Before this guard the
    // elision called `value.map(...)` and threw here.
    Object.defineProperty(circular, 'map', { value: null });

    const result = materializeToolResult({
      callId: 'c6-map',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('1,2,');
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
