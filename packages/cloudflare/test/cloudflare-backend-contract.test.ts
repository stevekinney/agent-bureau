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

runCloudflareBackendContract({
  label: 'fast double',
  capabilities: [{ name: 'vectorize', outcome: 'supported' }],
  now: () => Date.now(),
  createBindings(): Promise<CloudflareContractBindings> {
    return Promise.resolve({
      sqliteStorage: createCloudflareSqliteStorage({ sql: createSqliteDouble() }),
      r2Store: createCloudflareR2TextValueStore({ bucket: createFakeR2() }),
      memoryRecordStorage: createCloudflareMemoryRecordStorage({
        sql: createSqliteDouble(),
        vectorize: createFakeVectorize(),
      }),
    });
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
    return Promise.resolve({
      sqliteStorage: realLane.createFreshSqliteStorage(),
      r2Store: createCloudflareR2TextValueStore({ bucket: realLane.createFreshR2Bucket() }),
      memoryRecordStorage: undefined,
    });
  },
});
