/**
 * Isolated storage fixtures for the Bureau test harness (AB-261).
 *
 * Each fixture wraps a {@link StorageConfiguration} bureau can accept
 * directly via `BureauOptions.storage`, together with enough bookkeeping to
 * clean up afterward WITHOUT ever deleting a path the caller supplied
 * itself. The fixture never opens its own `Storage` handle against the
 * path it allocates — bureau's own `dispose()`/`shutdown()` owns and
 * closes the real backend handle (sqlite/lmdb) it composes from the
 * `configuration` passed through. Opening a second handle here, ahead of
 * bureau's, would race bureau's own open (and, for LMDB's single-writer
 * lock, could deadlock outright) — so this fixture's `dispose()` governs
 * only the filesystem lifecycle of a path IT allocated, never a live
 * database connection.
 *
 * A caller-supplied path is never touched by `dispose()`: `owned` is
 * `false` for it, and `dispose()` is then a pure no-op — "closes the
 * handle without deleting anything" reduces to "there is nothing this
 * fixture itself opened to close, and it deletes nothing" precisely
 * because ownership of the real connection lives with bureau, not here.
 *
 * `openHandles()` (AB-322) is the one exception to that "bureau owns the
 * real handle" rule, and only for `createMemoryStorageFixture`: rather
 * than a `{ type: 'memory' }` `StorageConfiguration` (which lets bureau
 * mint its own, unobservable `MemoryStorage`), the memory fixture
 * constructs and hands bureau a `Storage` INSTANCE it built itself
 * (`BureauOptions.storage`/`persistence.store` both accept one — see
 * `runtime-composition.ts`'s `isStorageConfiguration` discriminator) so it
 * can wrap that exact instance with public call accounting. This is safe
 * for memory specifically because there is no real file handle or
 * single-writer lock to race — the concern the module doc above raises
 * for sqlite/lmdb does not apply. `bureau.shutdown()` never disposes a
 * caller-supplied `Storage` INSTANCE (`ownsDurableStorage` in
 * `runtime-composition.ts` is `false` for it — only a `StorageConfiguration`
 * bureau resolves itself sets that flag), so `openHandles()` reporting a
 * call as still in flight is never a race against bureau's own teardown:
 * nothing but this fixture (or a test's own release of an injected block)
 * ever finishes that call. The sqlite/lmdb fixtures stay
 * `StorageConfiguration`-only and their `openHandles()` always returns
 * `[]` — they have nothing of their own to account for.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Storage, StorageConfiguration } from '@lostgradient/weft/storage';
import { MemoryStorage } from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';

/**
 * One isolated storage backend for a single test. `configuration` is ready
 * to pass straight to `BureauOptions.storage`. `path` is present only for
 * the persistent (sqlite/lmdb) backends. `owned: true` means this fixture
 * allocated `path` itself and `dispose()` removes it; `owned: false` means
 * the caller supplied `path` and `dispose()` leaves it alone.
 */
export interface BureauStorageFixture<
  TConfiguration extends StorageConfiguration | Storage = StorageConfiguration | Storage,
> {
  readonly configuration: TConfiguration;
  readonly path?: string;
  readonly owned: boolean;
  dispose(): Promise<void>;
  /**
   * Labels of every storage call this fixture's own accounting has seen
   * START but not yet FINISH (AB-322) — public handle accounting a test
   * (or `assertBureauQuiescent`'s `openStorageResources` row) can read
   * directly, with no private counter reached into from outside this
   * module. Always `[]` for `createSqliteStorageFixture`/
   * `createLmdbStorageFixture` — see the module doc for why only the
   * memory fixture can account for a real handle.
   */
  openHandles(): readonly string[];
}

/** The verbs {@link wrapStorageWithHandleAccounting} tracks — every async `Storage` method. `capabilities()`/`scoped()` are synchronous and excluded: nothing awaits them, so there is no "in flight" window to account for. */
const ACCOUNTED_STORAGE_VERBS = [
  'get',
  'put',
  'delete',
  'scan',
  'batch',
  'conditionalBatch',
  'has',
  'deletePrefix',
  'deleteRange',
  'keys',
  'count',
  'query',
] as const;

/**
 * Wraps `storage` with public call accounting: every call to one of
 * {@link ACCOUNTED_STORAGE_VERBS} is recorded the instant it is INVOKED
 * (before whatever it delegates to has any chance to resolve or block) and
 * removed the instant its returned `Promise` settles. `openHandles()`
 * reads the current set — synchronously, no polling — so a caller that
 * wraps `storage` again underneath (e.g. `createFaultEngine(...).wrapStorage`,
 * to block a specific call deterministically) sees that call recorded as
 * open for exactly as long as the block holds, because this wrapper's own
 * call to the layer beneath it does not settle until the block releases.
 */
function wrapStorageWithHandleAccounting(storage: Storage): {
  readonly storage: Storage;
  openHandles(): readonly string[];
} {
  const open = new Map<string, true>();
  let sequence = 0;

  const handler: ProxyHandler<Storage> = {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      const isAccountedVerb =
        typeof property === 'string' &&
        (ACCOUNTED_STORAGE_VERBS as readonly string[]).includes(property) &&
        typeof value === 'function';
      if (!isAccountedVerb) {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      const verb = property;
      return (...args: unknown[]) => {
        sequence += 1;
        const label = `${verb}#${sequence}`;
        open.set(label, true);
        const result: unknown = Reflect.apply(
          value as (...callArgs: unknown[]) => unknown,
          target,
          args,
        );
        if (result instanceof Promise) {
          void result.then(
            () => open.delete(label),
            () => open.delete(label),
          );
        } else {
          // A synchronous return (none of today's `ACCOUNTED_STORAGE_VERBS`
          // produce one, but the `Storage` interface does not guarantee
          // it) never left this call "in flight" to begin with.
          open.delete(label);
        }
        return result;
      };
    },
  };

  return {
    storage: new Proxy(storage, handler),
    openHandles: () => [...open.keys()],
  };
}

/** Options shared by the two persistent-backend fixture factories. */
export interface CreatePersistentStorageFixtureOptions {
  /**
   * The runtime whose `identifiers.next('storage-fixture')` sequence names
   * the allocated path when `path` is omitted. Required rather than
   * defaulted so two independently-constructed fixtures (each with its own
   * `ManualRuntimeServices`, per the harness's own isolation guarantee)
   * never coincidentally mint the same identifier suffix.
   */
  readonly runtime: RuntimeServices;
  /**
   * A caller-supplied path. When present, this fixture never allocates or
   * deletes anything — `owned` is `false` and `dispose()` is a no-op. When
   * omitted, a fresh path is allocated under the OS temp directory and
   * `owned` is `true`.
   */
  readonly path?: string;
}

/**
 * Process-local monotonic counter, used ONLY to keep two fixtures minted
 * from two DIFFERENT `RuntimeServices` instances (each with its own
 * `identifiers` counter starting at 1) from colliding on the same path
 * within this one process. Never consulted for anything the harness's own
 * determinism guarantees cover — it is disambiguation for a filesystem
 * path, not a source of test-observable behavior.
 */
let fixtureSequence = 0;

function allocateFixturePath(kind: 'sqlite' | 'lmdb', runtime: RuntimeServices): string {
  const identifier = runtime.identifiers.next('storage-fixture');
  fixtureSequence += 1;
  const suffix = kind === 'sqlite' ? '.sqlite' : '';
  return join(
    tmpdir(),
    `bureau-${kind}-fixture-${process.pid}-${fixtureSequence}-${identifier}${suffix}`,
  );
}

/** Options for {@link createMemoryStorageFixture}. */
export interface CreateMemoryStorageFixtureOptions {
  /**
   * Applied to the fixture's own freshly-constructed `MemoryStorage`
   * BEFORE this fixture's own handle-accounting wrapper wraps the result
   * (AB-322) — so a call this returns still-pending (e.g.
   * `createFaultEngine(...).wrapStorage`, blocking a specific call
   * deterministically) is correctly reported as still open by
   * `openHandles()` for exactly as long as it stays pending. Defaults to
   * the identity function.
   */
  wrapStorage?: (storage: Storage) => Storage;
}

/**
 * An in-memory `BureauStorageFixture`. Always `owned: true`. Unlike the
 * sqlite/lmdb fixtures below, this one constructs its own `MemoryStorage`
 * instance (see the module doc's `openHandles()` section for why that is
 * safe here specifically) and hands bureau that INSTANCE — not a `{ type:
 * 'memory' }` config — wrapped with public call accounting `openHandles()`
 * reads. `dispose()` disposes that instance (`MemoryStorage` holds no
 * filesystem or external resource, so this is a no-op in practice, but
 * bureau itself never disposes a caller-supplied `Storage` instance — see
 * the module doc — so this fixture must be the one that does, rather than
 * assuming a no-op the way the pre-AB-322 `{ type: 'memory' }` form could).
 */
export function createMemoryStorageFixture(
  options: CreateMemoryStorageFixtureOptions = {},
): BureauStorageFixture<Storage> {
  const rawStorage = new MemoryStorage();
  const wrapped = options.wrapStorage?.(rawStorage) ?? rawStorage;
  const { storage: accounted, openHandles } = wrapStorageWithHandleAccounting(wrapped);

  return {
    configuration: accounted,
    owned: true,
    async dispose() {
      rawStorage[Symbol.dispose]();
    },
    openHandles,
  };
}

/**
 * A SQLite-backed `BureauStorageFixture`. When `options.path` is omitted, a
 * fresh, unique path under the OS temp directory is allocated (the file
 * itself is created lazily, by whatever later opens `configuration` —
 * bureau, or a test asserting fixture behavior in isolation). `dispose()`
 * removes the database file plus its `-wal`/`-shm` sidecar files — if they
 * exist — when, and only when, this fixture allocated the path itself;
 * `rm(..., { force: true })` makes this safe to call whether or not
 * anything was ever written there, and idempotent on repeat calls.
 */
export function createSqliteStorageFixture(
  options: CreatePersistentStorageFixtureOptions,
): BureauStorageFixture<StorageConfiguration> {
  const owned = options.path === undefined;
  const path = options.path ?? allocateFixturePath('sqlite', options.runtime);

  return {
    configuration: { type: 'sqlite', path },
    path,
    owned,
    async dispose() {
      if (!owned) return;
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    },
    openHandles: () => [],
  };
}

/**
 * A LMDB-backed `BureauStorageFixture`. LMDB's configuration names a
 * directory, not a file — when `options.path` is omitted, a fresh, unique
 * directory path under the OS temp directory is allocated (created lazily
 * by whatever later opens `configuration`). `dispose()` removes the
 * directory (recursively, if it exists) when, and only when, this fixture
 * allocated the path itself.
 */
export function createLmdbStorageFixture(
  options: CreatePersistentStorageFixtureOptions,
): BureauStorageFixture<StorageConfiguration> {
  const owned = options.path === undefined;
  const path = options.path ?? allocateFixturePath('lmdb', options.runtime);

  return {
    configuration: { type: 'lmdb', path },
    path,
    owned,
    async dispose() {
      if (!owned) return;
      await rm(path, { recursive: true, force: true });
    },
    openHandles: () => [],
  };
}
