import { afterEach, describe, expect, it } from 'bun:test';

import { createCloudflareMemoryRecordStorage } from '../create-cloudflare-memory-record-storage';
import { createCloudflareR2TextValueStore } from '../create-cloudflare-r2-text-value-store';
import { createFakeVectorize } from './fake-vectorize';
import { type CloudflareRuntimeLane, startCloudflareRuntime } from './runtime-lane';
import { createSqliteDouble } from './sqlite-double';

/**
 * RESTART / REHYDRATION (AB-277). Per the AB-276 coordinator ruling this
 * runs against the REAL Miniflare/workerd lane for Durable Object SQLite and
 * R2 (the two backends the lane actually emulates locally), and against the
 * fast double for Vectorize (the memory-record backend's secondary index,
 * which the real lane never wires up — it is remote-only). A restart stops
 * the runtime after writing state, starts a fresh runtime over the SAME
 * persisted storage location, and asserts every record/tombstone rehydrates
 * IDENTICALLY, not spot-checked.
 */

// A per-process discriminant (not `crypto.randomUUID()`, which this
// deterministic test directory rejects): this box runs concurrent agent
// validation, so two processes running this file need distinct namespaces.
const processIdentifierPrefix = String(process.pid);
let identifierCounter = 0;
function nextIdentifier(): string {
  identifierCounter += 1;
  return `restart-${processIdentifierPrefix}-${identifierCounter}`;
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

/** Drains every `[key, bytes]` pair from a `Storage`'s full-range scan, sorted by key. */
async function dumpAllKeyValues(
  storage: Awaited<ReturnType<CloudflareRuntimeLane['createFreshSqliteStorage']>>,
): Promise<[string, number[]][]> {
  const entries: [string, number[]][] = [];
  for await (const [key, value] of storage.scan('')) {
    entries.push([key, Array.from(value)]);
  }
  return entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('restart and rehydration (real lane: Durable Object SQLite)', () => {
  it('rehydrates every record and tombstone identically after a restart over the same persisted storage', async () => {
    const original = await bootLane();
    lanes.pop(); // the restarted lane replaces it in `lanes` below.

    await original.sqliteStorage.put('restart:alpha', new Uint8Array([1, 2, 3]));
    await original.sqliteStorage.put('restart:beta', new Uint8Array([4, 5]));
    await original.sqliteStorage.put('restart:doomed', new Uint8Array([9]));
    await original.sqliteStorage.delete('restart:doomed'); // A hard delete: proves it stays gone.
    const beforeSnapshot = await dumpAllKeyValues(original.sqliteStorage);
    const beforeCapabilities = original.sqliteStorage.capabilities();

    const restarted = await original.restart();
    lanes.push(restarted);

    // Record-for-record equality, not a spot check.
    const afterSnapshot = await dumpAllKeyValues(restarted.sqliteStorage);
    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(afterSnapshot).toEqual([
      ['restart:alpha', [1, 2, 3]],
      ['restart:beta', [4, 5]],
    ]);
    expect(await restarted.sqliteStorage.get('restart:doomed')).toBeNull();
    expect(restarted.sqliteStorage.capabilities()).toEqual(beforeCapabilities);

    // Restart readiness was awaited through `restart()`'s own promise — no
    // wall-clock sleep was needed to observe the rehydrated state above.
    await restarted.sqliteStorage.put('restart:after', new Uint8Array([7]));
    expect(await restarted.sqliteStorage.get('restart:after')).toEqual(new Uint8Array([7]));
  });
});

describe('restart and rehydration (real lane: R2)', () => {
  it('rehydrates every object identically after a restart over the same persisted storage', async () => {
    const original = await bootLane();
    lanes.pop();

    const store = createCloudflareR2TextValueStore({ bucket: original.r2Bucket });
    await store.set('restart:kept-one', 'value one');
    await store.set('restart:kept-two', 'value two');
    await store.set('restart:doomed', 'gone soon');
    await store.delete('restart:doomed');

    const restarted = await original.restart();
    lanes.push(restarted);

    const restartedStore = createCloudflareR2TextValueStore({ bucket: restarted.r2Bucket });
    const listedKeys = await restartedStore.list('restart:');
    const keys = listedKeys.toSorted();
    expect(keys).toEqual(['restart:kept-one', 'restart:kept-two']);
    expect(await restartedStore.get('restart:kept-one')).toBe('value one');
    expect(await restartedStore.get('restart:kept-two')).toBe('value two');
    expect(await restartedStore.get('restart:doomed')).toBeNull();
  });
});

describe('restart and rehydration (fast double: Vectorize-backed memory records)', () => {
  // Per the AB-276 coordinator ruling the real lane never wires up Vectorize
  // (remote-only, no local emulator) — this backend's restart proof runs
  // against the fast double instead. "Restart" for a double with no real
  // process boundary means: a fresh adapter instance over the SAME
  // underlying sql/vectorize state, exactly as a production Durable Object
  // hands a fresh view to the next request after an eviction/restart.
  it('rehydrates every record and tombstone identically through a fresh adapter view over the same doubles', async () => {
    const sql = createSqliteDouble();
    const vectorize = createFakeVectorize();
    const original = createCloudflareMemoryRecordStorage({ sql, vectorize });
    await original.init();

    const scope = { tenantId: 'restart-tenant', namespace: 'restart-namespace' };
    await original.put({
      id: 'restart-kept',
      tenantId: scope.tenantId,
      namespace: scope.namespace,
      content: 'kept content',
      vector: new Float32Array([1, 0, 0]),
      metadata: { dedupeKey: 'restart-dedupe' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      version: 1,
      status: 'active',
    });
    await original.put({
      id: 'restart-doomed',
      tenantId: scope.tenantId,
      namespace: scope.namespace,
      content: 'doomed content',
      vector: new Float32Array([0, 1, 0]),
      metadata: {},
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      version: 1,
      status: 'active',
    });
    await original.delete('restart-doomed', scope);
    await original.close();

    // The "restart": a fresh adapter instance over the SAME sql/vectorize
    // doubles, mirroring `runCloudflareBackendContract`'s `reopen()`.
    const restarted = createCloudflareMemoryRecordStorage({ sql, vectorize });
    await restarted.init(); // Idempotent: schema + dedupe-key migration re-run safely.
    await restarted.init();

    const kept = await restarted.get('restart-kept', scope);
    expect(kept?.content).toBe('kept content');
    expect(await restarted.getByDedupeKey!(scope, 'restart-dedupe')).toBeDefined();
    expect(await restarted.get('restart-doomed', scope)).toBeUndefined();
    expect(await restarted.count(scope)).toBe(1);
  });
});
