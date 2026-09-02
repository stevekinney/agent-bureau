import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'bun:test';

import { createCloudflareR2TextValueStore } from '../create-cloudflare-r2-text-value-store';
import {
  cleanUpAfterStartupFailure,
  type CloudflareRuntimeLane,
  createSqliteStorageProxy,
  startCloudflareRuntime,
} from './runtime-lane';

/**
 * RUNTIME-ONLY ASSERTIONS. These behaviors genuinely cannot be observed
 * against the fast Bun doubles, so — unlike everything in
 * `behavior-contract.ts` — they exist only here, each with a one-line reason.
 */

let identifierCounter = 0;
function nextIdentifier(): string {
  identifierCounter += 1;
  return `runtime-only-${identifierCounter}`;
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
  'reports Vectorize as remote-only, matching the AB-276 coordinator ruling', async () => {
    const lane = await bootLane();

    expect(lane.vectorizeRemoteOnlyError).toMatch(/needs to be run remotely/);
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

    let thrown: unknown;
    try {
      await startCloudflareRuntime({
        identifiers: { next: () => failingIdentifier },
        packageRoot: '/nonexistent-cloudflare-package-root-for-failure-testing',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);

    // The failed lane never returned, so its `persistDirectory` was never
    // observable from here — recover the exact path it would have used
    // (deterministic from the injected identifier) and confirm it does
    // not exist.
    const entries = await readdir(tmpdir());
    const leaked = entries.filter((entry) =>
      entry.includes(`cloudflare-runtime-lane-${failingIdentifier}-`),
    );
    expect(leaked).toEqual([]);
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
});
