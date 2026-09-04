/**
 * Process-crash recovery conformance over the SQLite backend (AB-270).
 *
 * Every scenario here launches TWO real, separate OS processes
 * (`fixture.ts`) against a shared, uniquely-allocated temporary SQLite
 * file: the first is killed with `SIGKILL` at a named `CrashMarker`, and
 * the second recovers over the same backend path. This is deliberately the
 * slowest tier in the repository (real process boot, real SQLite I/O) —
 * see `.github/workflows/ci.yml`'s dedicated `crash-conformance-smoke` job
 * (one scenario, tagged `[smoke]` below) for the pull-request-lane subset,
 * and `bun run test:crash-conformance` for the full matrix.
 *
 * The scenario bodies themselves live in `scenarios.ts` (AB-271) — this
 * file and `lmdb.test.ts` both drive the SAME list against their own
 * backend, so the two backends can never silently drift onto different
 * marker matrices.
 */
import { describe, it } from 'bun:test';

import { CRASH_SCENARIOS } from './scenarios';

describe('crash conformance: SQLite backend (AB-270/AB-271)', () => {
  for (const scenario of CRASH_SCENARIOS) {
    it(scenario.name, () => scenario.run('sqlite'), scenario.timeoutMs);
  }
});
