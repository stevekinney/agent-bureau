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

  test("normalizeJSONValue preserves a circular array's own toString hook", () => {
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

  test("normalizeJSONValue preserves a circular array's Symbol.toPrimitive hook", () => {
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

  test("normalizeJSONValue preserves a circular array's overridden join", () => {
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

  test('normalizeJSONValue elides and retries when array coercion throws', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // Deterministic stand-in for the engine behaviour this guards against: Bun >= 1.4 throws a
    // RangeError out of the default join on a self-referential array, where 1.3.13 returns
    // '1,2,'. Forcing the throw here exercises the elide-and-retry path on BOTH engines, so the
    // recovery is covered on the pinned runtime rather than only on the newer one.
    Object.defineProperty(circular, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-throwing-join',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('1,2,');
  });

  test('normalizeJSONValue falls back to a tag when coercion throws and there is no cycle to break', () => {
    const unstringifiable: Record<string, unknown> = {
      // Forces JSON.stringify to throw, so the value reaches the last-resort coercion at all.
      big: 1n,
      toString: () => {
        throw new Error('coercion refused');
      },
    };

    const result = materializeToolResult({
      callId: 'c6-throwing-tostring',
      outcome: 'success',
      content: unstringifiable as any,
    });

    // Normalization must still produce a string rather than propagate the hook's error.
    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue survives a throwing Symbol.toStringTag on the terminal path', () => {
    const hostile: Record<string, unknown> = {
      // Forces JSON.stringify to throw so the value reaches the last-resort coercion.
      big: 1n,
      toString: () => {
        throw new Error('coercion refused');
      },
    };
    // `Object.prototype.toString` would Get(value, Symbol.toStringTag), so a throwing accessor
    // there used to escape materialization entirely. The terminal tag must not dispatch.
    Object.defineProperty(hostile, Symbol.toStringTag, {
      get: () => {
        throw new Error('toStringTag refused');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-hostile-tag',
      outcome: 'success',
      content: hostile as any,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test("normalizeJSONValue keeps a nested acyclic array's own toString through elision", () => {
    const inner: any[] = ['x'];
    Object.defineProperty(inner, 'toString', { value: () => 'INNER' });

    const outer: any[] = [inner];
    outer.push(outer);
    // Deterministic stand-in for the engine throw, so the elision path runs on both runtimes.
    Object.defineProperty(outer, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-nested-hook',
      outcome: 'success',
      content: outer as any,
    });

    // `inner` sits on no cycle, so it is returned by reference rather than rebuilt, and still
    // renders through its own hook. Only `outer` — which actually carries the back-reference —
    // is rewritten.
    expect(result.content).toBe('INNER,');
  });

  test('normalizeJSONValue tags a cycle whose elements still refuse coercion', () => {
    const refuses = {
      toString: () => {
        throw new Error('coercion refused');
      },
    };
    const circular: any[] = [refuses];
    circular.push(circular);
    Object.defineProperty(circular, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-cycle-then-refuse',
      outcome: 'success',
      content: circular as any,
    });

    // The cycle is broken, but the surviving element still throws, so the terminal tag applies.
    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue keeps a nested acyclic array holding NaN unrebuilt', () => {
    const inner: any[] = [Number.NaN];
    Object.defineProperty(inner, 'toString', { value: () => 'INNER' });

    const outer: any[] = [inner];
    outer.push(outer);
    Object.defineProperty(outer, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-nan',
      outcome: 'success',
      content: outer as any,
    });

    // `NaN !== NaN`, so an identity comparison would mark `inner` as changed, rebuild it as a
    // plain array and lose its hook — rendering 'NaN,' instead.
    expect(result.content).toBe('INNER,');
  });

  test('normalizeJSONValue leaves a proxy reporting a non-finite length untouched', () => {
    const target: any[] = [1, 2];
    Object.defineProperty(target, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        if (property === 'length') return Number.POSITIVE_INFINITY;
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    // An unguarded `for (i = 0; i < Infinity; i += 1)` would hang here rather than throw, which
    // is a worse failure than the one this function exists to prevent.
    const result = materializeToolResult({
      callId: 'c6-infinite-length',
      outcome: 'success',
      content: hostile as any,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue leaves a proxy reporting a length beyond the array limit untouched', () => {
    const target: any[] = [1, 2];
    Object.defineProperty(target, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        // A safe integer, so a bare Number.isSafeInteger check admits it — but far outside the
        // 2^32 - 1 a real array can report, so walking it would attempt billions of reads.
        if (property === 'length') return 2 ** 40;
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    const result = materializeToolResult({
      callId: 'c6-oversized-length',
      outcome: 'success',
      content: hostile as any,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue abandons an oversized traversal instead of walking it', () => {
    // A legitimate sparse array — no Proxy needed. Its length is a valid array length, so the
    // array-length cap accepts it; only the traversal budget stops the walk.
    const huge: any[] = new Array(2_000_000);
    huge[0] = 1n; // forces JSON.stringify to throw, so the last-resort path is reached
    Object.defineProperty(huge, 'join', {
      value: () => {
        throw new RangeError('simulated engine cycle overflow');
      },
    });

    const result = materializeToolResult({
      callId: 'c6-oversized-traversal',
      outcome: 'success',
      content: huge as any,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue contains a throw from the elision traversal itself', () => {
    const target: any[] = [1, 2];

    const hostile: any = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        // Fails both the initial coercion and the traversal that tries to rescue it.
        if (property === '0') throw new Error('index trap refused');
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    const result = materializeToolResult({
      callId: 'c6-throwing-traversal',
      outcome: 'success',
      content: hostile as any,
    });

    expect(result.content).toBe('[unstringifiable]');
  });

  test('normalizeJSONValue treats a null Symbol.toPrimitive as absent, not as a custom hook', () => {
    const circular: any[] = [1, 2];
    circular.push(circular);
    // JS coercion treats a null or undefined Symbol.toPrimitive as absent and falls through to
    // toString, so this must render like any other cyclic array.
    Object.defineProperty(circular, Symbol.toPrimitive, { value: null });

    const result = materializeToolResult({
      callId: 'c6-null-toprimitive',
      outcome: 'success',
      content: circular as any,
    });

    expect(result.content).toBe('1,2,');
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
