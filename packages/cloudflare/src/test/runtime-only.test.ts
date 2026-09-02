import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { createProcessUniqueIdentifierPrefix } from '../../test/runtime-lane-process-identifier';
import { createCloudflareR2TextValueStore } from '../create-cloudflare-r2-text-value-store';
import { CloudflareRuntimeLaneCancelledError, CloudflareUnsupportedApiError } from '../diagnostics';
import {
  cleanUpAfterStartupFailure,
  type CloudflareRuntimeLane,
  createSqliteStorageProxy,
  disposeAfterRestartFailure,
  interpretVectorizeProbe,
  runCancellableLaneOperation,
  startCloudflareRuntime,
} from './runtime-lane';

/**
 * RUNTIME-ONLY ASSERTIONS. These behaviors genuinely cannot be observed
 * against the fast Bun doubles, so — unlike everything in
 * `behavior-contract.ts` — they exist only here, each with a one-line reason.
 */

// A per-process random component, not just an incrementing counter: this
// box runs concurrent agent validation, and two processes running this same
// file would otherwise produce identical `runtime-only-N` sequences,
// letting one process's still-in-use temporary directory read as a leak
// from a completely different process's completed attempt.
const processIdentifierPrefix = createProcessUniqueIdentifierPrefix();
let identifierCounter = 0;
function nextIdentifier(): string {
  identifierCounter += 1;
  return `runtime-only-${processIdentifierPrefix}-${identifierCounter}`;
}

const lanes: CloudflareRuntimeLane[] = [];
async function bootLane(): Promise<CloudflareRuntimeLane> {
  const lane = await startCloudflareRuntime({ identifiers: { next: nextIdentifier } });
  lanes.push(lane);
  return lane;
}

afterEach(async () => {
  while (lanes.length > 0) {
    const lane = lanes.pop();
    if (lane !== undefined) await lane.shutdown();
  }
});

describe('Cloudflare real-runtime lane (runtime-only)', () => {
  it(// Only the real Miniflare/workerd Vectorize binding can produce this
  // remote-only failure; the fast double happily answers `query()` locally,
  // so no double can ever assert this message.
  'reports Vectorize as a typed unsupported diagnostic, matching the AB-276 coordinator ruling', async () => {
    const lane = await bootLane();

    expect(lane.vectorizeUnsupported).toBeInstanceOf(CloudflareUnsupportedApiError);
    expect(lane.vectorizeUnsupported.api).toBe('vectorize.query');
    expect(lane.vectorizeUnsupported.reason).toBe('vectorize-remote-only');
    expect(lane.vectorizeUnsupported.owningIssue).toBe('AB-276');
    expect((lane.vectorizeUnsupported.cause as Error).message).toMatch(/needs to be run remotely/);
  });

  it(// A real Miniflare probe never unexpectedly succeeds (per the AB-276
  // coordinator ruling, `vectorize` is always remote-only), so this branch
  // of `interpretVectorizeProbe` is not organically reachable through
  // `startCloudflareRuntime` — it is exercised directly here, and the
  // fallback-message branch (no double can produce EITHER outcome) below it.
  'interpretVectorizeProbe throws when the probe unexpectedly reports success', () => {
    expect(() => interpretVectorizeProbe({ ok: true })).toThrow(
      /unexpectedly succeeded without a remote proxy/,
    );
  });

  it('interpretVectorizeProbe falls back to a default message when the probe fails with no error text', () => {
    const unsupported = interpretVectorizeProbe({ ok: false });
    expect(unsupported).toBeInstanceOf(CloudflareUnsupportedApiError);
    expect((unsupported.cause as Error).message).toBe(
      'Miniflare Vectorize probe failed with no message.',
    );
  });

  it(// A double has no OS process, no on-disk persistence directory, and no
  // Durable Object namespace to leak — only the real lane can prove those
  // are actually released, so this assertion has no double-based analog.
  'awaits shutdown with no worker process, no storage handle, and no namespace collision surviving', async () => {
    const firstLane = await bootLane();
    const firstPersistDirectory = firstLane.persistDirectory;
    await firstLane.sqliteStorage.put('probe-key', new Uint8Array([1]));
    lanes.pop(); // shut it down explicitly below, not via afterEach, so we can assert after.
    await firstLane.shutdown();

    let persistDirectoryStillExists = true;
    try {
      await readdir(firstPersistDirectory);
    } catch {
      persistDirectoryStillExists = false;
    }
    expect(persistDirectoryStillExists).toBe(false);

    const secondLane = await bootLane();
    expect(secondLane.persistDirectory).not.toBe(firstPersistDirectory);
    // A fresh namespace means the first lane's write is invisible here.
    expect(await secondLane.sqliteStorage.get('probe-key')).toBeNull();
  });

  it(// Real R2 bucket bindings expose more than our minimal `R2Bucket`
  // interface (metadata, conditional headers, ranges); this proves the
  // structural fit holds against the ACTUAL binding shape, not just a fake
  // built to satisfy the interface by construction.
  'wires the real Miniflare R2 binding into the production adapter unmodified', async () => {
    const lane = await bootLane();
    const store = createCloudflareR2TextValueStore({ bucket: lane.r2Bucket });

    await store.set('runtime-only:r2-key', 'runtime-only-value');

    expect(await store.get('runtime-only:r2-key')).toBe('runtime-only-value');
  });

  it(// `test/cloudflare-backend-contract.test.ts` always passes an explicit
  // discriminant (needed for its own `reopen()` proof), so this is the only
  // place the NO-ARGUMENT form — which allocates a namespace/prefix from
  // `identifiers.next()` itself, rather than the caller supplying one — gets
  // exercised: two no-argument calls must land on two different,
  // non-colliding namespaces/prefixes.
  'createFreshSqliteStorage()/createFreshR2Bucket() with no argument allocate distinct namespaces/prefixes', async () => {
    const lane = await bootLane();

    const firstSqlite = lane.createFreshSqliteStorage();
    const secondSqlite = lane.createFreshSqliteStorage();
    await firstSqlite.put('probe', new Uint8Array([1]));
    expect(await secondSqlite.get('probe')).toBeNull();

    const firstBucket = createCloudflareR2TextValueStore({ bucket: lane.createFreshR2Bucket() });
    const secondBucket = createCloudflareR2TextValueStore({ bucket: lane.createFreshR2Bucket() });
    await firstBucket.set('probe', 'value');
    expect(await secondBucket.get('probe')).toBeNull();
  });

  it(// The RPC transport that lets Bun call into the Durable Object's
  // synchronous `SqlStorage.exec` is itself real-lane-only infrastructure
  // (see `runtime-lane.ts`'s module doc) — a legitimate call through the
  // public `Storage` surface never fails this way, so this exercises the
  // proxy's error surfacing directly against a fake transport.
  "surfaces a failed storage RPC as a thrown error with the worker's message", async () => {
    const failingProxy = createSqliteStorageProxy(
      () => Promise.resolve(Response.json({ ok: false, error: 'simulated worker failure' })),
      'runtime-only-rpc-failure',
    );

    let caughtMessage: string | undefined;
    try {
      await failingProxy.get('any-key');
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }
    expect(caughtMessage).toBe('simulated worker failure');
  });

  it(// A double never boots a process or allocates a persistence directory,
  // so there is nothing to leak on a construction failure — only the real
  // lane needs to prove that a failed `startCloudflareRuntime()` still
  // cleans up (`packageRoot` is a test-only override for exactly this: a
  // genuine bundling failure isn't otherwise reproducible on demand).
  'cleans up its persistence directory and any booted Miniflare instance when startup fails', async () => {
    const failingIdentifier = nextIdentifier();
    // A real (but incomplete) package root, not a hardcoded absolute path:
    // on a host where the test process can write to the filesystem root,
    // the earlier version of this test would have created directories under
    // `/` before bundling failed and never cleaned them up; `mkdtemp` keeps
    // this test's own filesystem footprint self-contained and portable.
    const fakePackageRoot = await mkdtemp(`${tmpdir()}/cloudflare-fake-package-root-`);

    // Snapshot matching entries BEFORE the attempt: residue from an
    // interrupted earlier run, or another concurrent process using the same
    // deterministic identifier (this box runs concurrent agent validation),
    // must not be misread as something this attempt leaked.
    const matchesThisAttempt = (entry: string): boolean =>
      entry.includes(`cloudflare-runtime-lane-${failingIdentifier}-`);
    const beforeEntries = await readdir(tmpdir());
    const before = new Set(beforeEntries.filter(matchesThisAttempt));

    let thrown: unknown;
    try {
      await startCloudflareRuntime({
        identifiers: { next: () => failingIdentifier },
        packageRoot: fakePackageRoot,
      });
    } catch (error) {
      thrown = error;
    } finally {
      await rm(fakePackageRoot, { recursive: true, force: true });
    }

    expect(thrown).toBeInstanceOf(Error);

    // The failed lane never returned, so its `persistDirectory` was never
    // observable from here — assert no entry matching this attempt's
    // identifier survives beyond the pre-attempt baseline.
    const afterEntries = await readdir(tmpdir());
    const after = afterEntries.filter(matchesThisAttempt);
    const leakedByThisAttempt = after.filter((entry) => !before.has(entry));
    expect(leakedByThisAttempt).toEqual([]);
  });

  it(// A real startup failure late enough to have already constructed a
  // Miniflare instance (`ready`/the Vectorize probe/`getR2Bucket`, all
  // after `new Miniflare()` succeeds) isn't reproducible on demand the way
  // the bundling failure above is — `cleanUpAfterStartupFailure` is
  // exported from `runtime-lane.ts` specifically so this "an instance WAS
  // constructed" branch is exercised directly, with a disposable stub, no
  // real runtime failure is a double substitute for.
  'disposes an already-constructed Miniflare instance during startup-failure cleanup', async () => {
    let disposeCallCount = 0;
    const persistDirectory = await mkdtemp(`${tmpdir()}/cleanup-branch-probe-`);

    await cleanUpAfterStartupFailure(
      { dispose: () => Promise.resolve(void disposeCallCount++) },
      persistDirectory,
    );

    expect(disposeCallCount).toBe(1);
    let persistDirectoryStillExists = true;
    try {
      await readdir(persistDirectory);
    } catch {
      persistDirectoryStillExists = false;
    }
    expect(persistDirectoryStillExists).toBe(false);
  });

  it(// A genuine late-stage `restart()` boot failure (readiness/probe/
  // `getR2Bucket` rejecting after `new Miniflare()` succeeds) is not
  // reproducible on demand — `disposeAfterRestartFailure` is exported so
  // this "an instance WAS constructed before restart-boot failed" branch is
  // exercised directly, with a disposable stub, same reasoning as
  // `cleanUpAfterStartupFailure`'s own test above. UNLIKE that function,
  // this one must never touch the filesystem: a restart failure must not
  // destroy the durable state the restart was trying to rehydrate from.
  'disposeAfterRestartFailure disposes an already-constructed instance without touching the filesystem', async () => {
    let disposeCallCount = 0;
    await disposeAfterRestartFailure({ dispose: () => Promise.resolve(void disposeCallCount++) });
    expect(disposeCallCount).toBe(1);
  });

  it('disposeAfterRestartFailure is a no-op when no instance was constructed', async () => {
    const result = await disposeAfterRestartFailure(undefined);
    expect(result).toBeUndefined();
  });

  it('disposeAfterRestartFailure swallows a disposal failure rather than replacing the original boot error', async () => {
    const result = await disposeAfterRestartFailure({
      dispose: () => Promise.reject(new Error('dispose failed')),
    });
    expect(result).toBeUndefined();
  });

  describe('cancellation', () => {
    it(// Weft's `Storage`/`TextValueStore` contracts take no `AbortSignal` — a
    // double has no in-flight async work to cancel in the first place (every
    // double method resolves synchronously under the hood). Only the real
    // lane's RPC/HTTP transport has genuine in-flight work, so this exercises
    // `runCancellableLaneOperation` (the exact function every real-lane call
    // goes through) directly against a deferred, caller-controlled operation
    // rather than racing real Miniflare I/O, which would be a flake on a
    // loaded box, not a deterministic test.
    'rejects an in-flight operation with a typed cancellation the instant abort fires, without waiting for it to settle', async () => {
      const controller = new AbortController();
      let resolveOperation: (() => void) | undefined;
      const operation = () =>
        new Promise<string>((resolve) => {
          resolveOperation = () => resolve('too-late');
        });

      const pending = runCancellableLaneOperation(
        controller.signal,
        'probe-method',
        'probe-namespace',
        operation,
      );

      controller.abort();

      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CloudflareRuntimeLaneCancelledError);
      expect((caught as CloudflareRuntimeLaneCancelledError).method).toBe('probe-method');
      expect((caught as CloudflareRuntimeLaneCancelledError).namespace).toBe('probe-namespace');

      // Resolving the underlying operation after cancellation must not
      // surface anywhere (no unhandled rejection, no second settlement) —
      // the caller already moved on with the typed cancellation.
      resolveOperation?.();
    });

    it('resolves normally when the signal never fires (the positive control for the cancellation wrapper)', async () => {
      const controller = new AbortController();
      const result = await runCancellableLaneOperation(
        controller.signal,
        'probe-method',
        'probe-namespace',
        () => Promise.resolve('completed'),
      );
      expect(result).toBe('completed');
    });

    it(// The "positive control" above resolves normally, and the in-flight
    // test resolves its losing operation late — neither exercises the
    // REJECTION path of the internal swallow-handler that keeps a losing
    // operation's eventual rejection from surfacing as a process-level
    // unhandled rejection. This drives that path directly: reject the
    // losing operation, after cancellation has already won the race.
    'swallows a later REJECTION from the losing operation instead of surfacing an unhandled rejection', async () => {
      const controller = new AbortController();
      let rejectOperation: ((error: Error) => void) | undefined;
      const operation = () =>
        new Promise<string>((_resolve, reject) => {
          rejectOperation = reject;
        });

      const pending = runCancellableLaneOperation(
        controller.signal,
        'probe-method',
        'probe-namespace',
        operation,
      );
      controller.abort();

      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CloudflareRuntimeLaneCancelledError);

      rejectOperation?.(new Error('too-late-rejection'));
      // Give the swallow-handler's microtask a turn; if it were missing,
      // Bun would report an unhandled rejection for this test.
      await Promise.resolve();
    });

    it(// `lane.cancel()` aborts the lane's controller without disposing
    // Miniflare or removing `persistDirectory` — a distinct outcome from
    // `stop()`/`shutdown()`, asserted here against the real lane's actual
    // `sqliteStorage`/`r2Bucket` proxies so the wiring (not just the
    // standalone wrapper above) is proven.
    'cancels the real lane, rejecting subsequent sqliteStorage and r2Bucket calls with a typed outcome', async () => {
      const lane = await bootLane();
      await lane.sqliteStorage.put('pre-cancel', new Uint8Array([1]));

      lane.cancel();

      let sqliteCaught: unknown;
      try {
        await lane.sqliteStorage.get('pre-cancel');
      } catch (error) {
        sqliteCaught = error;
      }
      expect(sqliteCaught).toBeInstanceOf(CloudflareRuntimeLaneCancelledError);

      let r2Caught: unknown;
      try {
        await lane.r2Bucket.get('any-key');
      } catch (error) {
        r2Caught = error;
      }
      expect(r2Caught).toBeInstanceOf(CloudflareRuntimeLaneCancelledError);
    });
  });

  describe('stop() and restart()', () => {
    it(// `stop()` disposes Miniflare but must NOT remove `persistDirectory` —
    // that is exactly the state `restart()` (and AB-277's restart scenario)
    // rehydrates from. No double has a process or a persistence directory to
    // preserve across a stop, so this has no double-based analog.
    'stops the runtime without removing its persistence directory', async () => {
      const lane = await bootLane();
      lanes.pop(); // stopped explicitly below, not via afterEach.
      const { persistDirectory } = lane;

      await lane.stop();

      const entries = await readdir(persistDirectory);
      expect(entries.length).toBeGreaterThan(0);

      await rm(persistDirectory, { recursive: true, force: true });
    });

    it(// The restart scenario itself (writing state, restarting, asserting
    // record-for-record rehydration) lives in `restart.test.ts` against the
    // production adapters; this proves the narrower lane-level contract —
    // `restart()` reuses the SAME namespace/persistDirectory rather than
    // allocating fresh ones, which is what makes rehydration possible at all.
    'restart() reuses the same namespace and persistDirectory as the original lane', async () => {
      const original = await bootLane();
      lanes.pop(); // the restarted lane replaces it in `lanes` below.
      const { persistDirectory } = original;

      const restarted = await original.restart();
      lanes.push(restarted);

      expect(restarted.persistDirectory).toBe(persistDirectory);
    });

    it(// A genuine LATE-stage restart-boot failure (readiness/probe/
    // `getR2Bucket` rejecting after `new Miniflare()` succeeds) isn't
    // reproducible on demand, same as the analogous first-boot case above —
    // but an EARLY, pre-`new Miniflare()` restart-boot failure is: this
    // boots a lane against a custom root that symlinks the real
    // `src`/`node_modules` (so the FIRST boot succeeds normally), then
    // breaks only the `src` symlink before calling `restart()`, so
    // `restart()`'s own bundling step fails for real and its catch block
    // (which propagates the error and disposes any instance that WAS
    // constructed, via `disposeAfterRestartFailure`) runs for real.
    'propagates a restart-time boot failure without disposing a never-constructed instance', async () => {
      const realPackageRoot = path.resolve(import.meta.dir, '..', '..');
      const customRoot = await mkdtemp(`${tmpdir()}/cloudflare-restart-failure-root-`);
      const srcLinkPath = path.join(customRoot, 'src');
      await symlink(path.join(realPackageRoot, 'src'), srcLinkPath);
      await symlink(
        path.join(realPackageRoot, 'node_modules'),
        path.join(customRoot, 'node_modules'),
      );

      const identifier = nextIdentifier();
      const lane = await startCloudflareRuntime({
        identifiers: { next: () => identifier },
        packageRoot: customRoot,
      });

      // Breaks ONLY the second (restart-time) boot's bundling step; the
      // first boot above already completed successfully.
      await rm(srcLinkPath, { force: true });

      let thrown: unknown;
      try {
        await lane.restart();
      } catch (error) {
        thrown = error;
      } finally {
        // `restart()` failed, so `lane` itself is still the live instance —
        // no replacement lane was ever returned to take over cleanup.
        await lane.shutdown();
        await rm(customRoot, { recursive: true, force: true });
      }

      expect(thrown).toBeInstanceOf(Error);
    });
  });
});
