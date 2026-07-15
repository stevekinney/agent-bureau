import { Engine } from '@lostgradient/weft';
import type { StorageCapabilities } from '@lostgradient/weft/storage/interface';
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/weft/storage/testing';
import { describe, expect, it } from 'bun:test';

import { createCloudflareSqliteStorage } from '../src/create-cloudflare-sqlite-storage';
import { createSqliteDouble } from '../src/test/sqlite-double';

/**
 * THE HONESTY CHECK: runs Weft's shared `Storage` adapter conformance suites —
 * the same suites Weft's own built-in adapters (Memory, BunSQLite, LMDB, ...)
 * must pass — against `createCloudflareSqliteStorage`, wired to the
 * bun:sqlite-backed `Sql` double that stands in for Durable Object
 * `ctx.storage.sql` under `bun:test`.
 *
 * A fresh double per `create()` call keeps every case isolated; each double
 * owns its own in-memory `bun:sqlite` database, so there is no cross-test
 * state to reset.
 */

const EXPECTED_CAPABILITIES: StorageCapabilities = {
  persistence: 'local',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
};

runBasicStorageContract('CloudflareSqliteStorage', {
  create: () => createCloudflareSqliteStorage({ sql: createSqliteDouble() }),
});

runStorageCapabilityConformance('CloudflareSqliteStorage', {
  create: () => createCloudflareSqliteStorage({ sql: createSqliteDouble() }),
  expected: EXPECTED_CAPABILITIES,
});

runConcurrentConditionalBatchConformance('CloudflareSqliteStorage', {
  create: () => createCloudflareSqliteStorage({ sql: createSqliteDouble() }),
});

runBinaryAndLargeScanStorageConformance('CloudflareSqliteStorage', {
  create: () => createCloudflareSqliteStorage({ sql: createSqliteDouble() }),
});

describe('CloudflareSqliteStorage supports manual Weft maintenance', () => {
  it('runs a host-driven maintenance cycle without platform timers', async () => {
    const storage = createCloudflareSqliteStorage({ sql: createSqliteDouble() });
    const engine = await Engine.create({
      storage,
      recover: false,
      backgroundTasks: 'manual',
      startScheduler: false,
    });

    try {
      await expect(engine.runMaintenance()).resolves.toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
