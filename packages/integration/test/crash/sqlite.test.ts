/**
 * Process-crash recovery conformance over the SQLite backend (AB-270).
 *
 * Every `it` here launches TWO real, separate OS processes (`fixture.ts`)
 * against a shared, uniquely-allocated temporary SQLite file: the first is
 * killed with `SIGKILL` at a named `CrashMarker`, and the second recovers
 * over the same backend path. This is deliberately the slowest tier in the
 * repository (real process boot, real SQLite I/O) — see
 * `.github/workflows/ci.yml`'s dedicated `crash-conformance-smoke` job
 * (one scenario, tagged `[smoke]` below) for the pull-request-lane subset,
 * and `bun run test:crash-conformance` for the full matrix.
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

describe('crash conformance: SQLite backend (AB-270)', () => {
  it('[smoke] kill-vs-control honesty pair: killing at checkpoint-committed recovers a committed effect; a control killed at run-started never reaches it', async () => {
    const runtime = createManualRuntimeServices();

    const killed = await runCrashScenario({ runtime, killAtMarker: 'checkpoint-committed' });
    const control = await runCrashScenario({ runtime, killAtMarker: 'run-started' });

    expectCleanRecoveryShape(killed);
    expectCleanRecoveryShape(control);

    // Both processes were really killed, at genuinely different points —
    // the discriminator this pair exists to prove.
    expect(marker(killed.first, 'checkpoint-committed')).toBeDefined();
    expect(marker(killed.first, 'effect-attempted')).toBeDefined();
    expect(marker(control.first, 'run-started')).toBeDefined();
    expect(marker(control.first, 'checkpoint-committed')).toBeUndefined();
    expect(marker(control.first, 'effect-attempted')).toBeUndefined();

    // The honest field: killed-at-checkpoint-committed recovers the
    // effect's idempotency-cache entry fully COMMITTED (the effect ran
    // and was acknowledged before the kill); the run-started control
    // never got far enough to create one at all. If a harness bug meant
    // "kill" did nothing, these two would read identically.
    expect(observation(killed.second, 'effect-cache-entry')).toMatchObject({
      status: 'completed',
      result: { ok: true },
    });
    expect(observation(control.second, 'effect-cache-entry')).toBeNull();
    expect(observation(control.second, 'child-record')).toBeNull();

    // Fencing evidence (AB-178, consumed as external guarantee — see
    // WFT-30/WFT-32): the recovered run is the SAME durable identifier
    // the first process minted, reaching exactly one terminal
    // transition, never a rival execution racing the dead process.
    const runId = marker(killed.first, 'run-started')?.detail?.['runId'];
    expect(typeof runId).toBe('string');
    const recoveredState = observation(killed.second, 'final-root-workflow-state') as {
      id?: string;
      status?: string;
    } | null;
    expect(recoveredState?.id).toBe(runId as string);
    expect(recoveredState?.status).toBe('cancelled');
  }, 60_000);

  it('killed at ready: no durable run was ever started, and recovery finds nothing to resume', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'ready' });

    expectCleanRecoveryShape(report);
    expect(marker(report.first, 'ready')).toBeDefined();
    expect(marker(report.first, 'run-started')).toBeUndefined();

    expect(observation(report.second, 'resumed-root-run-id')).toBeNull();
    expect(observation(report.second, 'final-root-workflow-state')).toBeNull();
  }, 30_000);

  it('killed at child-registered: the durably-recorded child identifier survives, and recovery never dispatches a second child', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'child-registered' });

    expectCleanRecoveryShape(report);

    const firstChildId = marker(report.first, 'child-registered')?.detail?.['childRunId'];
    expect(typeof firstChildId).toBe('string');

    // The kv record itself is written before the kill point, independent
    // of Weft's own step checkpoint, so it survives verbatim — the SAME
    // durable identifier and parentage the first process recorded.
    expect(observation(report.second, 'child-record')).toMatchObject({
      childRunId: firstChildId,
    });

    // Replay re-enters the SAME step (its own checkpoint never
    // committed) and finds the idempotency-cache "started" marker this
    // first attempt left behind — it reports the marker again, flagged
    // as a duplicate attempt, and returns WITHOUT dispatching a second
    // child.
    const secondChildMarker = marker(report.second, 'child-registered');
    expect(secondChildMarker?.detail?.['duplicateAttempt']).toBe(true);

    // Once the ambiguous registration is resolved (without a duplicate
    // dispatch), the workflow proceeds normally — the effect step runs
    // for the first time in this run's lifecycle, exactly once.
    expect(observation(report.second, 'effect-count')).toBe('1');
  }, 30_000);

  it('killed at effect-attempted: an explicit unknown-outcome attempt record survives, asserted positively and negatively, and the effect never duplicates', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'effect-attempted' });

    expectCleanRecoveryShape(report);

    // Positive: the unknown-outcome record exists and is readable
    // through the public surface (`bureau.kv`, via the fixture's
    // observation of its own idempotency-cache entry).
    const entry = observation(report.second, 'effect-cache-entry');
    expect(entry).toMatchObject({ status: 'started' });

    // Negative: nothing anywhere in the recovered state claims a
    // rollback or an exactly-once guarantee for this attempt.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toMatch(/rolledBack/i);
    expect(serialized).not.toMatch(/exactlyOnce/i);
    const fullSerialized = JSON.stringify(report.second.observations);
    expect(fullSerialized).not.toMatch(/rolledBack/i);
    expect(fullSerialized).not.toMatch(/exactlyOnce/i);

    // The effect genuinely ran exactly once — not zero, not twice — and
    // was never silently replayed by the second process.
    expect(observation(report.second, 'effect-count')).toBe('1');
    const secondEffectMarker = marker(report.second, 'effect-attempted');
    expect(secondEffectMarker?.detail?.['duplicateAttempt']).toBe(true);
  }, 30_000);

  it('killed at signal-parked: the durable run recovers into the SAME parked state, and the second process cancels it explicitly', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'signal-parked' });

    expectCleanRecoveryShape(report);
    expect(marker(report.first, 'signal-parked')).toBeDefined();
    expect(marker(report.first, 'cancellation-recorded')).toBeUndefined();

    // The park itself was durably checkpointed (Weft's `ctx.waitForSignal`
    // IS the checkpoint), so recovery observes it parked again rather
    // than replaying the whole step — resumption according to contract.
    expect(marker(report.second, 'signal-parked')).toBeDefined();
    expect(marker(report.second, 'cancellation-recorded')).toBeDefined();

    const recoveredState = observation(report.second, 'final-root-workflow-state') as {
      status?: string;
    } | null;
    expect(recoveredState?.status).toBe('cancelled');
  }, 30_000);

  it('killed at cancellation-recorded: the recovered process observes exactly one terminal transition, never a second', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'cancellation-recorded' });

    expectCleanRecoveryShape(report);
    expect(marker(report.first, 'cancellation-recorded')).toBeDefined();

    // The cancellation itself already committed before the kill — the
    // second process finds a terminal run and takes no further action on
    // it (no second `signal-parked`/`cancellation-recorded` pair).
    expect(marker(report.second, 'signal-parked')).toBeUndefined();
    expect(marker(report.second, 'cancellation-recorded')).toBeUndefined();

    const recoveredState = observation(report.second, 'final-root-workflow-state') as {
      status?: string;
    } | null;
    expect(recoveredState?.status).toBe('cancelled');
  }, 30_000);

  it('killed at cleanup-completed: the final process had already reached quiescence, and recovery is a clean no-op', async () => {
    const runtime = createManualRuntimeServices();
    const report = await runCrashScenario({ runtime, killAtMarker: 'cleanup-completed' });

    expectCleanRecoveryShape(report);
    expect(marker(report.first, 'cleanup-completed')).toBeDefined();
    expect(observation(report.first, 'quiescent')).toBe(true);

    // Recovery over an already fully-shut-down, terminal backend finds
    // nothing in flight — the second process's own quiescence report
    // (asserted by `expectCleanRecoveryShape`) is its own proof.
    const recoveredState = observation(report.second, 'final-root-workflow-state') as {
      status?: string;
    } | null;
    expect(recoveredState?.status).toBe('cancelled');
  }, 30_000);
});
