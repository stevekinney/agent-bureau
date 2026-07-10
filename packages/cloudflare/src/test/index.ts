import {
  createCloudflareMemoryRecordStorage,
  type CreateCloudflareMemoryRecordStorageOptions,
} from '../create-cloudflare-memory-record-storage';
import { createFakeVectorize, type FakeVectorize } from './fake-vectorize';
import { createSqliteDouble, type SqliteDouble } from './sqlite-double';

export { createFakeR2, type FakeR2 } from './fake-r2';
export {
  createFakeVectorize,
  type FakeVectorize,
  type PoisonHit,
  type RecordedQuery,
} from './fake-vectorize';
export { createSqliteDouble, type SqliteDouble } from './sqlite-double';

/**
 * A Cloudflare memory backend wired entirely to test doubles, with the doubles
 * exposed for white-box assertions (recorded Vectorize calls, raw SQL rows).
 */
export interface CloudflareMemoryTestHarness {
  /** The backend under test, wired to {@link CloudflareMemoryTestHarness.sql} and {@link CloudflareMemoryTestHarness.vectorize}. */
  storage: ReturnType<typeof createCloudflareMemoryRecordStorage>;
  /** The bun:sqlite-backed canonical store double. */
  sql: SqliteDouble;
  /** The recording, adversarial Vectorize fake. */
  vectorize: FakeVectorize;
}

/**
 * Wires the Cloudflare memory backend to a fresh bun:sqlite double and a fresh
 * adversarial Vectorize fake, returning all three so tests can assert both the
 * backend's observable behavior AND the secondary-index calls it makes.
 *
 * `options` are forwarded to {@link createCloudflareMemoryRecordStorage} (e.g. a
 * custom `tableName`); `sql` and `vectorize` are supplied by this helper.
 */
export function createCloudflareMemoryTestHarness(
  options?: Omit<CreateCloudflareMemoryRecordStorageOptions, 'sql' | 'vectorize'>,
): CloudflareMemoryTestHarness {
  const sql = createSqliteDouble();
  const vectorize = createFakeVectorize();
  const storage = createCloudflareMemoryRecordStorage({ ...options, sql, vectorize });
  return { storage, sql, vectorize };
}
