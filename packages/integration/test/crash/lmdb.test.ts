/**
 * Process-crash recovery conformance over the LMDB backend (AB-335).
 *
 * This is deliberately narrow — one scenario, not the full matrix
 * `sqlite.test.ts` drives. AB-335's job was to root-cause and fix the one
 * LMDB-specific defect the "killed at child-registered" scenario exposed
 * (see `fixture.ts`'s `depsPromise` comment for the mechanism and fix);
 * extracting a shared scenario list so every marker in the matrix runs over
 * BOTH backends is AB-271's scope, which was blocked on this issue.
 *
 * Same shape as `sqlite.test.ts`'s own version of this scenario: two real,
 * separate OS processes (`fixture.ts`) against a shared, uniquely-allocated
 * temporary LMDB directory — the first killed with `SIGKILL` at
 * `child-registered`, the second recovering over the same backend path.
 */
import { createManualRuntimeServices } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import { runCrashScenario } from './harness';
import type { CrashFixtureMessage } from './protocol';

type MarkerMessage = Extract<CrashFixtureMessage, { type: 'marker' }>;

function marker(
  outcome: Awaited<ReturnType<typeof runCrashScenario>>['first'],
  name: MarkerMessage['marker'],
) {
  return outcome.markers.find((entry) => entry.marker === name);
}

function observation(
  outcome: Awaited<ReturnType<typeof runCrashScenario>>['first'],
  label: string,
): unknown {
  return outcome.observations.find((entry) => entry.label === label)?.value;
}

/** True once every check that must hold for EVERY scenario in this file holds. */
function expectCleanRecoveryShape(report: Awaited<ReturnType<typeof runCrashScenario>>): void {
  // The first process was genuinely, abruptly terminated — never asked to
  // shut down gracefully. This is the harness's own honesty floor: a
  // scenario that only *thinks* it killed something proves nothing.
  expect(report.first.signalCode).toBe('SIGKILL');
  expect(report.first.fatal).toBeUndefined();

  // The second process always reaches a clean, voluntary exit.
  expect(report.second.exitCode).toBe(0);
  expect(report.second.signalCode).toBeNull();
  expect(report.second.fatal).toBeUndefined();
  expect(marker(report.second, 'ready')).toBeDefined();
  expect(marker(report.second, 'cleanup-completed')).toBeDefined();

  // tst-03c: the Bureau quiescence report the final process produces is
  // empty — no leaked child, timer, listener, webhook delivery, or
  // non-terminal durable run.
  expect(observation(report.second, 'quiescent')).toBe(true);

  // No descendant of either process's pid survived the kill.
  expect(report.noOrphanedProcesses).toBe(true);
}

describe('crash conformance: LMDB backend (AB-335)', () => {
  it('killed at child-registered: the durably-recorded child identifier survives, and recovery never dispatches a second child', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({
      runtime,
      backend: 'lmdb',
      killAtMarker: 'child-registered',
    });

    expectCleanRecoveryShape(report);

    const firstChildId = marker(report.first, 'child-registered')?.detail?.['childRunId'];
    expect(typeof firstChildId).toBe('string');

    // The kv record itself is written before the kill point, independent of
    // Weft's own step checkpoint, so it survives verbatim — the SAME durable
    // identifier and parentage the first process recorded.
    expect(observation(report.second, 'child-record')).toMatchObject({
      childRunId: firstChildId,
    });

    // AB-335: before the fix, the recovered process never re-invoked
    // `register-child` at all — a recovered run's first step could already
    // be dispatching tool calls before this fixture's own dependencies were
    // wired (`create-bureau.ts`: "Boot returns once `recoverAll()` has
    // STARTED the handles... not when they complete"), so the tool's
    // `execute()` threw a phantom "not ready" error that Weft's per-step
    // memo durably checkpointed as step 0's final result — replay then
    // skipped straight to `perform-effect` with a `duplicateAttempt` of
    // `undefined`, never reaching armorer's `claimStarted` a second time.
    // Fixed by awaiting the fixture's own dependencies instead of throwing
    // when they are not yet wired (`fixture.ts`'s `depsPromise`).
    const secondChildMarker = marker(report.second, 'child-registered');
    expect(secondChildMarker?.detail?.['duplicateAttempt']).toBe(true);

    // Once the ambiguous registration is resolved (without a duplicate
    // dispatch), the workflow proceeds normally — the effect step runs for
    // the first time in this run's lifecycle, exactly once.
    expect(observation(report.second, 'effect-count')).toBe('1');
  }, 30_000);
});
