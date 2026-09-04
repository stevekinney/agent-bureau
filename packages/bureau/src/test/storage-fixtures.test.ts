import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

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
    expect(first.configuration).toEqual({ type: 'lmdb', path: first.path! });
    expect(first.owned).toBe(true);
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
