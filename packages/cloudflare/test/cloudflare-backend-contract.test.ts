import { afterAll, beforeAll } from 'bun:test';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createCloudflareR2TextValueStore } from '../src/create-cloudflare-r2-text-value-store';
import { createCloudflareSqliteStorage } from '../src/create-cloudflare-sqlite-storage';
import {
  type CloudflareContractBindings,
  runCloudflareBackendContract,
} from '../src/test/behavior-contract';
import { createFakeR2 } from '../src/test/fake-r2';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { type CloudflareRuntimeLane, startCloudflareRuntime } from '../src/test/runtime-lane';
import { createSqliteDouble } from '../src/test/sqlite-double';

/**
 * THE HONESTY CHECK: `runCloudflareBackendContract` runs once against the fast
 * Bun doubles and once against a real Miniflare/workerd runtime lane, so "the
 * same behavior contract runs against the double and the real runtime" (the
 * AB-276 acceptance criterion) is structurally true. Vectorize is unsupported
 * on the real lane per the coordinator ruling (`owningIssue: 'AB-276'`,
 * `reason: 'vectorize-remote-only'`); `runCloudflareBackendContract` asserts
 * that typed outcome instead of exercising `MemoryRecordStorage` there.
 */

/**
 * Wires one set of fast-double adapter instances (`sqliteStorage`, `r2Store`,
 * `memoryRecordStorage`) over the given underlying doubles. `reopen()` closes
 * over the SAME `sql`/`bucket`/`memorySql`/`vectorize` doubles and calls this
 * again — never fresh doubles — proving `close()`/`[Symbol.dispose]()` are
 * non-owning: a reopened view reads back exactly what the original view
 * wrote. Every reopened view can itself be reopened again, the same way a
 * real production adapter can.
 */
function wireFastDoubleBindings(
  sql: ReturnType<typeof createSqliteDouble>,
  bucket: ReturnType<typeof createFakeR2>,
  memorySql: ReturnType<typeof createSqliteDouble>,
  vectorize: ReturnType<typeof createFakeVectorize>,
): CloudflareContractBindings {
  return {
    sqliteStorage: createCloudflareSqliteStorage({ sql }),
    r2Store: createCloudflareR2TextValueStore({ bucket }),
    memoryRecordStorage: createCloudflareMemoryRecordStorage({ sql: memorySql, vectorize }),
    reopen(): Promise<CloudflareContractBindings> {
      return Promise.resolve(wireFastDoubleBindings(sql, bucket, memorySql, vectorize));
    },
  };
}

runCloudflareBackendContract({
  label: 'fast double',
  capabilities: [{ name: 'vectorize', outcome: 'supported' }],
  now: () => Date.now(),
  createBindings(): Promise<CloudflareContractBindings> {
    return Promise.resolve(
      wireFastDoubleBindings(
        createSqliteDouble(),
        createFakeR2(),
        createSqliteDouble(),
        createFakeVectorize(),
      ),
    );
  },
});

let identifierCounter = 0;
function nextIdentifier(): string {
  identifierCounter += 1;
  return `backend-contract-${identifierCounter}`;
}

let realLane: CloudflareRuntimeLane;

beforeAll(async () => {
  realLane = await startCloudflareRuntime({ identifiers: { next: nextIdentifier } });
});

afterAll(async () => {
  await realLane.shutdown();
});

runCloudflareBackendContract({
  label: 'real runtime',
  capabilities: [
    {
      name: 'vectorize',
      outcome: 'unsupported',
      owningIssue: 'AB-276',
      reason: 'vectorize-remote-only',
    },
  ],
  now: () => Date.now(),
  createBindings(): Promise<CloudflareContractBindings> {
    // A fresh Durable Object namespace and a fresh R2 key prefix per case —
    // not `realLane.sqliteStorage`/`realLane.r2Bucket` directly — so each
    // contract case runs against a clean slate, the same isolation the fast
    // double gets from a fresh `createSqliteDouble()`/`createFakeR2()` per
    // call, without paying to boot a whole new lane per case.
    return Promise.resolve(wireRealLaneBindings(nextIdentifier()));
  },
});

/**
 * Wires one set of real-lane adapter instances over the Durable Object
 * namespace / R2 key prefix `discriminant` names. `reopen()` reuses the SAME
 * `discriminant` — a SECOND, independent view over the SAME namespace/prefix,
 * per {@link CloudflareRuntimeLane.createFreshSqliteStorage}'s explicit-suffix
 * form — proving `close()`/`[Symbol.dispose]()` are non-owning on the real
 * runtime too.
 */
function wireRealLaneBindings(discriminant: string): CloudflareContractBindings {
  return {
    sqliteStorage: realLane.createFreshSqliteStorage(discriminant),
    r2Store: createCloudflareR2TextValueStore({
      bucket: realLane.createFreshR2Bucket(discriminant),
    }),
    memoryRecordStorage: undefined,
    reopen(): Promise<CloudflareContractBindings> {
      return Promise.resolve(wireRealLaneBindings(discriminant));
    },
  };
}
