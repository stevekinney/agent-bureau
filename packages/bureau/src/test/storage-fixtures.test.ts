import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
} from './storage-fixtures';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface VerbStorage {
  get(key: string): unknown;
  count(): unknown;
  scan(): unknown;
  keys(): unknown;
  query(): unknown;
}

describe('createMemoryStorageFixture', () => {
  it('returns an owned Storage instance (AB-322: not a bare configuration) with no path', () => {
    const fixture = createMemoryStorageFixture();

    // AB-322: `configuration` is now a real `Storage` instance this
    // fixture constructed itself (wrapped with handle accounting), not a
    // bare `{ type: 'memory' }` config — `get`/`put`/`delete` are callable
    // directly, and `capabilities()` still reports the real MemoryStorage
    // profile.
    expect(typeof (fixture.configuration as { get?: unknown }).get).toBe('function');
    expect(typeof (fixture.configuration as { put?: unknown }).put).toBe('function');
    expect(fixture.path).toBeUndefined();
    expect(fixture.owned).toBe(true);
  });

  it('is idempotent to dispose repeatedly', async () => {
    const fixture = createMemoryStorageFixture();

    await fixture.dispose();
    await fixture.dispose();
  });

  it('openHandles() is empty before any call and after every call settles', async () => {
    const fixture = createMemoryStorageFixture();
    const storage = fixture.configuration as {
      get(key: string): Promise<Uint8Array | null>;
      put(key: string, value: Uint8Array): Promise<void>;
    };

    expect(fixture.openHandles()).toEqual([]);

    await storage.put('key', new Uint8Array([1]));
    expect(fixture.openHandles()).toEqual([]);

    await storage.get('key');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() names a call started but not yet finished, through a caller-supplied wrapStorage', async () => {
    let releaseGet!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const fixture = createMemoryStorageFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== 'get') return Reflect.get(target, property, receiver);
            return async (key: string) => {
              await blocked;
              return target.get(key);
            };
          },
        }),
    });
    const storage = fixture.configuration as { get(key: string): Promise<Uint8Array | null> };

    const getPromise = storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    releaseGet();
    await getPromise;
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears a call that REJECTS too, not only one that resolves', async () => {
    const fixture = createMemoryStorageFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== 'get') return Reflect.get(target, property, receiver);
            return async (): Promise<Uint8Array | null> => {
              throw new Error('deliberate failure');
            };
          },
        }),
    });
    const storage = fixture.configuration as { get(key: string): Promise<Uint8Array | null> };

    let caught: unknown;
    try {
      await storage.get('key');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('deliberate failure');
    expect(fixture.openHandles()).toEqual([]);
  });

  /** A fixture whose `verb` is replaced by `replacement`, through `wrapStorage`. */
  function fixtureWithVerb(verb: string, replacement: (...args: unknown[]) => unknown) {
    const fixture = createMemoryStorageFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== verb) return Reflect.get(target, property, receiver);
            return replacement;
          },
        }),
    });
    return { fixture, storage: fixture.configuration as unknown as VerbStorage };
  }

  /** A thenable that is not a native Promise and settles only when told to. */
  function manualThenable() {
    let onFulfilled: ((value: unknown) => void) | undefined;
    let onRejected: ((reason: unknown) => void) | undefined;
    const thenable = {
      then(resolve?: (value: unknown) => void, reject?: (reason: unknown) => void) {
        onFulfilled = resolve;
        onRejected = reject;
      },
    };
    return {
      thenable,
      resolve: (value: unknown) => onFulfilled?.(value),
      reject: (reason: unknown) => onRejected?.(reason),
    };
  }

  it('openHandles() keeps a non-native thenable open until it resolves', () => {
    const manual = manualThenable();
    expect(manual.thenable instanceof Promise).toBe(false);
    const { fixture, storage } = fixtureWithVerb('get', () => manual.thenable);

    storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    manual.resolve(null);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() keeps a non-native thenable open until it rejects', () => {
    const manual = manualThenable();
    const { fixture, storage } = fixtureWithVerb('get', () => manual.thenable);

    storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    manual.reject(new Error('deliberate failure'));
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() still closes a genuinely synchronous return immediately', () => {
    const { fixture, storage } = fixtureWithVerb('count', () => 3);

    expect(storage.count()).toBe(3);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() closes immediately for a synchronous non-thenable object return', () => {
    const { fixture, storage } = fixtureWithVerb('count', () => ({ n: 1 }));

    expect(storage.count()).toEqual({ n: 1 });
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() closes and still returns the value when a thenable throws in then()', () => {
    const thenable = {
      then() {
        throw new Error('boom');
      },
    };
    const { fixture, storage } = fixtureWithVerb('get', () => thenable);

    expect(storage.get('key')).toBe(thenable);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() tracks a frozen AsyncIterable without a Proxy invariant error', async () => {
    const iterable = Object.freeze({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            return index <= 2
              ? { done: false as const, value: index }
              : { done: true as const, value: undefined };
          },
        };
      },
    });
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const seen: number[] = [];
    for await (const value of storage.scan() as AsyncIterable<number>) {
      seen.push(value);
      expect(fixture.openHandles()).toEqual(['scan#1']);
    }
    expect(seen).toEqual([1, 2]);
    expect(fixture.openHandles()).toEqual([]);
  });

  function manualIterable() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            await gate;
            index += 1;
            return index <= 2
              ? { done: false as const, value: index }
              : { done: true as const, value: undefined };
          },
          async return() {
            return { done: true as const, value: undefined };
          },
          async throw(error?: unknown) {
            throw error;
          },
        };
      },
    };
    return { iterable, release };
  }

  it('openHandles() keeps an AsyncIterable open until iteration is exhausted', async () => {
    const { iterable, release } = manualIterable();
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const seen: number[] = [];
    const iteration = (async () => {
      for await (const value of storage.scan() as AsyncIterable<number>) seen.push(value);
    })();
    expect(fixture.openHandles()).toEqual(['scan#1']);

    release();
    await iteration;
    expect(seen).toEqual([1, 2]);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() keeps an AsyncIterable open until the consumer breaks out (return())', async () => {
    const { iterable, release } = manualIterable();
    release();
    const { fixture, storage } = fixtureWithVerb('keys', () => iterable);

    for await (const value of storage.keys() as AsyncIterable<number>) {
      expect(value).toBe(1);
      expect(fixture.openHandles()).toEqual(['keys#1']);
      break;
    }
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an AsyncIterable whose iteration throws', async () => {
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('deliberate failure');
        },
      }),
    };
    const { fixture, storage } = fixtureWithVerb('query', () => failing);

    const iterator = (storage.query() as AsyncIterable<number>)[Symbol.asyncIterator]();
    expect(fixture.openHandles()).toEqual(['query#1']);
    expect(await throwingRejectionOf(iterator.next())).toThrow('deliberate failure');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an AsyncIterable when the consumer calls throw()', async () => {
    const { iterable, release } = manualIterable();
    release();
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const iterator = (storage.scan() as AsyncIterable<number>)[Symbol.asyncIterator]();
    await iterator.next();
    expect(fixture.openHandles()).toEqual(['scan#1']);
    expect(await throwingRejectionOf(iterator.throw?.(new Error('stop')))).toThrow('stop');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() tracks next()/return() called directly on an iterator-shaped result', async () => {
    async function* generate(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    const { fixture, storage } = fixtureWithVerb('scan', () => generate());

    const iterator = storage.scan() as AsyncGenerator<number>;
    expect(fixture.openHandles()).toEqual(['scan#1']);
    const first = await iterator.next();
    expect(first.value).toBe(1);
    expect(fixture.openHandles()).toEqual(['scan#1']);
    await iterator.return(undefined);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an iterator-shaped result when throw() is called directly', async () => {
    async function* generate(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    const { fixture, storage } = fixtureWithVerb('keys', () => generate());

    const iterator = storage.keys() as AsyncGenerator<number>;
    await iterator.next();
    expect(fixture.openHandles()).toEqual(['keys#1']);
    expect(await throwingRejectionOf(iterator.throw(new Error('stop')))).toThrow('stop');
    expect(fixture.openHandles()).toEqual([]);
  });
});

describe('createSqliteStorageFixture', () => {
  it('allocates a unique path derived from the runtime identifier sequence, never Math.random or a wall clock', () => {
    const runtime = createManualRuntimeServices();

    const first = createSqliteStorageFixture({ runtime });
    const second = createSqliteStorageFixture({ runtime });

    expect(first.path).toBeDefined();
    expect(second.path).toBeDefined();
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain('storage-fixture-1');
    expect(second.path).toContain('storage-fixture-2');
    expect(first.configuration).toEqual({ type: 'sqlite', path: first.path! });
    expect(first.owned).toBe(true);
  });

  it('gives two independent runtimes distinct paths despite each identifier sequence starting at 1', () => {
    const runtimeA = createManualRuntimeServices();
    const runtimeB = createManualRuntimeServices();

    const fixtureA = createSqliteStorageFixture({ runtime: runtimeA });
    const fixtureB = createSqliteStorageFixture({ runtime: runtimeB });

    expect(fixtureA.path).not.toBe(fixtureB.path);
  });

  it('deletes only a path it allocated itself', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    const path = fixture.path!;

    await writeFile(path, '');
    expect(await pathExists(path)).toBe(true);

    await fixture.dispose();

    expect(await pathExists(path)).toBe(false);
  });

  it('is idempotent: disposing an owned fixture twice does not throw', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });

    await fixture.dispose();
    await fixture.dispose();
  });

  it('never deletes a caller-supplied path', async () => {
    const runtime = createManualRuntimeServices();
    const callerPath = join(tmpdir(), `bureau-caller-owned-sqlite-${process.pid}.sqlite`);
    await writeFile(callerPath, '');

    try {
      const fixture = createSqliteStorageFixture({ runtime, path: callerPath });

      expect(fixture.owned).toBe(false);
      expect(fixture.path).toBe(callerPath);
      expect(fixture.configuration).toEqual({ type: 'sqlite', path: callerPath });

      await fixture.dispose();

      expect(await pathExists(callerPath)).toBe(true);
    } finally {
      await rm(callerPath, { force: true });
    }
  });

  it('openHandles() always returns empty — this fixture never opens its own handle (see the module doc)', () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });

    expect(fixture.openHandles()).toEqual([]);
  });
});

describe('createLmdbStorageFixture', () => {
  it('allocates a unique directory path derived from the runtime identifier sequence', () => {
    const runtime = createManualRuntimeServices();

    const first = createLmdbStorageFixture({ runtime });
    const second = createLmdbStorageFixture({ runtime });

    expect(first.path).not.toBe(second.path);
    expect(first.configuration).toEqual({
      type: 'lmdb',
      path: first.path!,
      durability: 'full',
    });
    expect(first.owned).toBe(true);
  });

  it('allows an isolation test to select relaxed durability explicitly', () => {
    const fixture = createLmdbStorageFixture({
      runtime: createManualRuntimeServices(),
      durability: 'relaxed',
    });

    expect(fixture.configuration).toEqual({
      type: 'lmdb',
      path: fixture.path!,
      durability: 'relaxed',
    });
  });

  it('deletes only a directory it allocated itself', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });
    const path = fixture.path!;

    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'data.mdb'), '');
    expect(await pathExists(path)).toBe(true);

    await fixture.dispose();

    expect(await pathExists(path)).toBe(false);
  });

  it('never deletes a caller-supplied directory', async () => {
    const runtime = createManualRuntimeServices();
    const callerPath = join(tmpdir(), `bureau-caller-owned-lmdb-${process.pid}`);
    await mkdir(callerPath, { recursive: true });

    try {
      const fixture = createLmdbStorageFixture({ runtime, path: callerPath });

      expect(fixture.owned).toBe(false);

      await fixture.dispose();

      expect(await pathExists(callerPath)).toBe(true);
    } finally {
      await rm(callerPath, { recursive: true, force: true });
    }
  });

  it('is idempotent: disposing an owned fixture twice does not throw', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });

    await fixture.dispose();
    await fixture.dispose();
  });

  it('openHandles() always returns empty — this fixture never opens its own handle (see the module doc)', () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });

    expect(fixture.openHandles()).toEqual([]);
  });
});
