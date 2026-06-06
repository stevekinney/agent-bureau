import { runMemoryRecordStorageContract } from 'memory/test/contract-harness';

import { createCloudflareMemoryRecordStorage } from '../src/create-cloudflare-memory-record-storage';
import { createFakeVectorize } from '../src/test/fake-vectorize';
import { createSqliteDouble } from '../src/test/sqlite-double';

/**
 * THE HONESTY CHECK: runs the single shared {@link runMemoryRecordStorageContract}
 * suite — the same byte-identical assertions the local in-memory and Weft
 * backends pass — against the Cloudflare backend (SQLite canonical + adversarial
 * Vectorize fake).
 *
 * This backend REQUIRES a `tenantId`, so the suite is given a scope decorator
 * that fills in a default tenant for scopes that omit one. The decorator
 * preserves an already-set `tenantId` so the suite's tenant-isolation assertions
 * (`t1`/`t2`) keep their two distinct tenants.
 *
 * Backend-specific concerns (rehydration security, tombstone ordering, decode
 * validation, tenant/namespace required) live in the sibling test files, not
 * here.
 */
runMemoryRecordStorageContract({
  label: 'cloudflare',
  makeBackend: () =>
    createCloudflareMemoryRecordStorage({
      sql: createSqliteDouble(),
      vectorize: createFakeVectorize(),
    }),
  scope: (base) => ({ ...base, tenantId: base.tenantId ?? 'default-tenant' }),
});
