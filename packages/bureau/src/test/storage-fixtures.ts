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
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageConfiguration } from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';

/**
 * One isolated storage backend for a single test. `configuration` is ready
 * to pass straight to `BureauOptions.storage`. `path` is present only for
 * the persistent (sqlite/lmdb) backends. `owned: true` means this fixture
 * allocated `path` itself and `dispose()` removes it; `owned: false` means
 * the caller supplied `path` and `dispose()` leaves it alone.
 */
export interface BureauStorageFixture {
  readonly configuration: StorageConfiguration;
  readonly path?: string;
  readonly owned: boolean;
  dispose(): Promise<void>;
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

/**
 * An in-memory `BureauStorageFixture`. Always `owned: true`, but `dispose()`
 * has nothing to remove — `MemoryStorage` holds no filesystem or external
 * resource — so it is a no-op every time, safely repeatable.
 */
export function createMemoryStorageFixture(): BureauStorageFixture {
  return {
    configuration: { type: 'memory' },
    owned: true,
    async dispose() {
      // Nothing to release: in-memory storage owns no external resource.
    },
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
): BureauStorageFixture {
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
): BureauStorageFixture {
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
  };
}
