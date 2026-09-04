/**
 * Process-crash recovery conformance over the LMDB backend (AB-335/AB-271).
 *
 * LMDB is a currently shipped, currently configurable persistent Bureau
 * storage backend (`packages/gateway/src/start.ts:67` declares
 * `STORAGE_TYPE: z.enum(['sqlite', 'lmdb', 'memory'])`), so AB-92 assigns
 * its conformance gap to this issue. This file drives the IDENTICAL
 * scenario list `sqlite.test.ts` drives (`scenarios.ts`, shared verbatim)
 * against `createLmdbStorageFixture` instead — every difference from the
 * SQLite lane would be a finding, not a scenario to weaken. AB-335 already
 * root-caused and fixed the one real LMDB-specific defect this matrix
 * exposed (the recovered-run tool-dependency race — see `fixture.ts`'s
 * `getDeps()` comment); no other backend-specific gap was found, so the
 * full eleven-scenario matrix runs unmodified here (`harness.ts`'s
 * `CrashHarnessUnsupportedBehaviorError` stays available as a typed escape
 * hatch for a future gap, but nothing in this matrix trips it).
 *
 * Same shape as `sqlite.test.ts`: two real, separate OS processes
 * (`fixture.ts`) against a shared, uniquely-allocated temporary LMDB
 * directory per scenario.
 */
import { describe, it } from 'bun:test';

import { CRASH_SCENARIOS } from './scenarios';

describe('crash conformance: LMDB backend (AB-335/AB-271)', () => {
  for (const scenario of CRASH_SCENARIOS) {
    it(scenario.name, () => scenario.run('lmdb'), scenario.timeoutMs);
  }
});
