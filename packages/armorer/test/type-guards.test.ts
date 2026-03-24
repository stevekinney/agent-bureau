import { describe, expect, it } from 'bun:test';

import { isAsyncIterable, isPromise, isTestRuntime } from '../src/utilities/type-guards';

describe('isAsyncIterable', () => {
  it('returns true for an async generator', () => {
    async function* gen() {
      yield 1;
    }
    expect(isAsyncIterable(gen())).toBe(true);
  });

  it('returns true for an object with Symbol.asyncIterator', () => {
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    expect(isAsyncIterable(iterable)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isAsyncIterable(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAsyncIterable(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isAsyncIterable('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isAsyncIterable(42)).toBe(false);
  });

  it('returns false for a plain object', () => {
    expect(isAsyncIterable({ a: 1 })).toBe(false);
  });

  it('returns false for a regular iterable', () => {
    expect(isAsyncIterable([1, 2, 3])).toBe(false);
  });

  it('returns true for a function with Symbol.asyncIterator', () => {
    const fn = () => {};
    (fn as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = () => ({
      next: async () => ({ done: true as const, value: undefined }),
    });
    expect(isAsyncIterable(fn)).toBe(true);
  });
});

describe('isPromise', () => {
  it('returns true for a native Promise', () => {
    expect(isPromise(Promise.resolve(42))).toBe(true);
  });

  it('returns true for a thenable', () => {
    const thenable = { then: (resolve: (value: number) => void) => resolve(42) };
    expect(isPromise(thenable)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isPromise(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPromise(undefined)).toBe(false);
  });

  it('returns false for a plain object', () => {
    expect(isPromise({ a: 1 })).toBe(false);
  });

  it('returns false for an object with a non-function then', () => {
    expect(isPromise({ then: 42 })).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isPromise('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isPromise(123)).toBe(false);
  });
});

describe('isTestRuntime', () => {
  it('returns true in test environment', () => {
    expect(isTestRuntime()).toBe(true);
  });
});
