/**
 * The crash-conformance scenario list (AB-271), shared verbatim between
 * `sqlite.test.ts` (AB-270) and `lmdb.test.ts` (AB-271/AB-335) — the two
 * backend files consume this SAME list rather than each defining their own,
 * so the marker matrix can never silently drift apart per backend (AB-271:
 * "The two backends share one scenario list. A backend-specific behavior
 * that genuinely cannot be supported fails before starting work with a
 * typed error naming the unsupported behavior... Reducing the matrix
 * silently for one backend is not permitted.").
 *
 * Each scenario is a self-contained `it`-body: it allocates its own
 * `ManualRuntimeServices`, drives `runCrashScenario` (once, or in a pair for
 * the `[smoke]` honesty check), and asserts. `run(backend)` is called from
 * inside a `bun:test` `it(...)`, so `expect` failures surface normally.
 *
 * Scope note: seven of these eleven scenarios (the `[smoke]` pair plus
 * `ready`/`child-registered`/`effect-attempted`/`signal-parked`/
 * `cancellation-recorded`/`cleanup-completed`) are AB-270's original matrix,
 * extracted here unchanged. The remaining four are AB-271's own scope:
 * `nested children`, a schedule DEFINITION surviving a crash during
 * registration (see that scenario's own comment for why it does not drive
 * an actual fire), `signal-parked resume with a pre-kill signal`, and the
 * AB-29 `recovery failure`. AB-271's own "cancellation" acceptance
 * criterion — "crashes at the
 * `'cancellation-recorded'` marker and asserts the recovered process
 * observes the cancellation as recorded rather than replaying the run" — is
 * satisfied by the pre-existing `killed at cancellation-recorded` scenario
 * below, now running over LMDB for the first time via `lmdb.test.ts`; no
 * new scenario was needed for it.
 */
import { createManualRuntimeServices } from '@lostgradient/operative/test';
import { expect } from 'bun:test';

import { type CrashBackend, runCrashScenario } from './harness';
import type { CrashFixtureMessage } from './protocol';

type MarkerMessage = Extract<CrashFixtureMessage, { type: 'marker' }>;
type ScenarioReport = Awaited<ReturnType<typeof runCrashScenario>>;

export function marker(outcome: ScenarioReport['first'], name: MarkerMessage['marker']) {
  return outcome.markers.find((entry) => entry.marker === name);
}

export function markersNamed(outcome: ScenarioReport['first'], name: MarkerMessage['marker']) {
  return outcome.markers.filter((entry) => entry.marker === name);
}

export function observation(outcome: ScenarioReport['first'], label: string): unknown {
  return outcome.observations.find((entry) => entry.label === label)?.value;
}

/** True once every check that must hold for EVERY scenario in this matrix holds. */
export function expectCleanRecoveryShape(report: ScenarioReport): void {
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

export interface CrashScenario {
  readonly name: string;
  readonly timeoutMs: number;
  run(backend: CrashBackend): Promise<void>;
}

export const CRASH_SCENARIOS: readonly CrashScenario[] = [
  // ── AB-270's original seven scenarios ──────────────────────────────
  {
    name: '[smoke] kill-vs-control honesty pair: killing at checkpoint-committed recovers a committed effect; a control killed at run-started never reaches it',
    timeoutMs: 60_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();

      const killed = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'checkpoint-committed',
      });
      const control = await runCrashScenario({ runtime, backend, killAtMarker: 'run-started' });

      expectCleanRecoveryShape(killed);
      expectCleanRecoveryShape(control);

      expect(marker(killed.first, 'checkpoint-committed')).toBeDefined();
      expect(marker(killed.first, 'effect-attempted')).toBeDefined();
      expect(marker(control.first, 'run-started')).toBeDefined();
      expect(marker(control.first, 'checkpoint-committed')).toBeUndefined();
      expect(marker(control.first, 'effect-attempted')).toBeUndefined();

      expect(observation(killed.second, 'effect-cache-entry')).toMatchObject({
        status: 'completed',
        result: { ok: true },
      });
      expect(observation(control.second, 'effect-cache-entry')).toBeNull();
      expect(observation(control.second, 'child-record')).toBeNull();

      const runId = marker(killed.first, 'run-started')?.detail?.['runId'];
      expect(typeof runId).toBe('string');
      const recoveredState = observation(killed.second, 'final-root-workflow-state') as {
        id?: string;
        status?: string;
      } | null;
      expect(recoveredState?.id).toBe(runId as string);
      expect(recoveredState?.status).toBe('cancelled');
    },
  },
  {
    name: 'killed at ready: no durable run was ever started, and recovery finds nothing to resume',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({ runtime, backend, killAtMarker: 'ready' });

      expectCleanRecoveryShape(report);
      expect(marker(report.first, 'ready')).toBeDefined();
      expect(marker(report.first, 'run-started')).toBeUndefined();

      expect(observation(report.second, 'resumed-root-run-id')).toBeNull();
      expect(observation(report.second, 'final-root-workflow-state')).toBeNull();
    },
  },
  {
    name: 'killed at child-registered: the durably-recorded child identifier survives, and recovery never dispatches a second child',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'child-registered',
      });

      expectCleanRecoveryShape(report);

      const firstChildId = marker(report.first, 'child-registered')?.detail?.['childRunId'];
      expect(typeof firstChildId).toBe('string');

      expect(observation(report.second, 'child-record')).toMatchObject({
        childRunId: firstChildId,
      });

      const secondChildMarker = marker(report.second, 'child-registered');
      expect(secondChildMarker?.detail?.['duplicateAttempt']).toBe(true);

      expect(observation(report.second, 'effect-count')).toBe('1');
    },
  },
  {
    name: 'killed at effect-attempted: an explicit unknown-outcome attempt record survives, asserted positively and negatively, and the effect never duplicates',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'effect-attempted',
      });

      expectCleanRecoveryShape(report);

      const entry = observation(report.second, 'effect-cache-entry');
      expect(entry).toMatchObject({ status: 'started' });

      const serialized = JSON.stringify(entry);
      expect(serialized).not.toMatch(/rolledBack/i);
      expect(serialized).not.toMatch(/exactlyOnce/i);
      const fullSerialized = JSON.stringify(report.second.observations);
      expect(fullSerialized).not.toMatch(/rolledBack/i);
      expect(fullSerialized).not.toMatch(/exactlyOnce/i);

      expect(observation(report.second, 'effect-count')).toBe('1');
      const secondEffectMarker = marker(report.second, 'effect-attempted');
      expect(secondEffectMarker?.detail?.['duplicateAttempt']).toBe(true);
    },
  },
  {
    name: 'killed at signal-parked: the durable run recovers into the SAME parked state, and the second process cancels it explicitly',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({ runtime, backend, killAtMarker: 'signal-parked' });

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
    },
  },
  {
    // AB-271's "cancellation" acceptance criterion is this scenario,
    // unmodified — see this file's top comment.
    name: 'killed at cancellation-recorded: the recovered process observes exactly one terminal transition, never a second',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'cancellation-recorded',
      });

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
    },
  },
  {
    name: 'killed at cleanup-completed: the final process had already reached quiescence, and recovery is a clean no-op',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'cleanup-completed',
      });

      expectCleanRecoveryShape(report);
      expect(marker(report.first, 'cleanup-completed')).toBeDefined();
      expect(observation(report.first, 'quiescent')).toBe(true);

      const recoveredState = observation(report.second, 'final-root-workflow-state') as {
        status?: string;
      } | null;
      expect(recoveredState?.status).toBe('cancelled');
    },
  },

  // ── AB-271's harder scenarios ───────────────────────────────────────
  {
    name: 'nested children: crashed while a parent run has two live children, and recovery preserves both identities without a duplicate terminal transition, then aborting the recovered root aborts both children',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        kind: 'nested-children',
        killAtMarker: 'children-registered',
      });

      expectCleanRecoveryShape(report);

      const firstMarker = marker(report.first, 'children-registered');
      const firstChildren = firstMarker?.detail?.['children'] as
        Array<{ index: number; childRunId: string }> | undefined;
      expect(firstChildren?.length).toBe(2);
      const firstIds = (firstChildren ?? []).map((entry) => entry.childRunId).filter(Boolean);

      // Recovery reports the marker again (replay re-enters the step),
      // flagged as a duplicate attempt for at least the slot(s) that had
      // already committed before the kill — never a fresh dispatch.
      const secondMarker = marker(report.second, 'children-registered');
      const secondChildren = secondMarker?.detail?.['children'] as
        Array<{ index: number; childRunId: string; duplicateAttempt: boolean }> | undefined;
      expect(secondChildren?.some((entry) => entry.duplicateAttempt)).toBe(true);

      const nestedChildren = observation(report.second, 'nested-children') as
        | Array<{
            index: number;
            record: { childRunId: string; parentRunId: string } | null;
            status: string | null;
          }>
        | undefined;
      expect(nestedChildren?.length).toBe(2);
      for (const entry of nestedChildren ?? []) {
        // Identity survives recovery — the SAME durable ids the first
        // process minted, correctly parented.
        expect(entry.record?.parentRunId).toBeDefined();
        expect(firstIds.includes(entry.record?.childRunId ?? '')).toBe(true);
        // Cascade abort: the recovered root's cancellation aborted both
        // children too, through this fixture's own explicit `abortRun`
        // cascade (Bureau exposes no native parent→child durable
        // cancellation — AB-92's decision record). `abortRun`'s terminal
        // durable status is `'cancelled'`, the same value the root's own
        // cancellation reaches elsewhere in this matrix.
        expect(entry.status).toBe('cancelled');
      }

      const recoveredState = observation(report.second, 'final-root-workflow-state') as {
        status?: string;
      } | null;
      expect(recoveredState?.status).toBe('cancelled');
    },
  },
  {
    // Honest scope (per copilot review on PR #555): this scenario does NOT
    // drive an actual schedule fire — Bureau's recurring poller cannot be
    // driven deterministically through any public surface (WFT-141,
    // verified directly: a throwaway probe repeatedly calling
    // `bureau.runDurableMaintenance` against a registered schedule never
    // fired it). It crashes DURING SCHEDULE REGISTRATION instead, and
    // proves two things unrelated to any fire: the schedule DEFINITION
    // survives the crash (`bureau.getSchedule`), and the root run's own
    // `perform-effect` step still keeps its existing exactly-once guarantee
    // while that schedule exists. AB-97's "running schedule fire"
    // acceptance criterion is therefore only partially covered by this
    // scenario — see `packages/integration/README.md`'s matching note.
    name: "schedule definition survives a crash during registration, with the root run's own exactly-once effect unaffected",
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        kind: 'schedule-fire',
        killAtMarker: 'schedule-registered',
      });

      expectCleanRecoveryShape(report);
      expect(marker(report.first, 'schedule-registered')).toBeDefined();

      // The schedule DEFINITION survives the crash, readable through
      // `bureau.getSchedule` in the recovered process.
      const scheduleSummary = observation(report.second, 'schedule-summary') as {
        id?: string;
      } | null;
      expect(scheduleSummary?.id).toBeDefined();

      // The root run's own `perform-effect` step — unrelated to the
      // schedule above — never duplicates: the same exactly-once guarantee
      // `effect-attempted` proves for the base linear scenario, now merely
      // co-located with a run that also registered a schedule.
      expect(observation(report.second, 'effect-count')).toBe('1');

      const recoveredState = observation(report.second, 'final-root-workflow-state') as {
        status?: string;
      } | null;
      expect(recoveredState?.status).toBe('cancelled');
    },
  },
  {
    name: 'signal-parked resume: a signal delivered right before the kill is not double-delivered, and the recovered process resumes with exactly one continuation',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        killAtMarker: 'signal-parked',
        resumeOnSignalParked: true,
        deliverSignalBeforeKill: true,
      });

      expectCleanRecoveryShape(report);

      // Parked exactly once before the kill — the harness's in-flight
      // "proceed" write, sent immediately before the SIGKILL, may or may
      // not have been consumed by the dying process; either way this is
      // the only `signal-parked` report the first process ever makes.
      expect(markersNamed(report.first, 'signal-parked').length).toBe(1);
      expect(marker(report.first, 'cancellation-recorded')).toBeUndefined();

      // Recovery observes the SAME park (durably checkpointed by
      // `ctx.waitForSignal`) exactly once and resumes it (never cancels) —
      // `main()`'s shared terminal-status marker fires unconditionally
      // once the run settles either way, so the discriminator here is the
      // FINAL STATUS below, not this marker's presence.
      expect(markersNamed(report.second, 'signal-parked').length).toBe(1);

      const recoveredState = observation(report.second, 'final-root-workflow-state') as {
        status?: string;
      } | null;
      // AB-44: approving continues the SAME run with one more generation
      // step, reaching `createFixtureGenerate`'s `default` branch and
      // completing — never `cancelled`, and never `failed` from a
      // duplicate/conflicting resolution.
      expect(recoveredState?.status).toBe('completed');
    },
  },
  {
    name: 'recovery failure (AB-29): the second process omits the catalog agent, and the observable recovery failure carries its failure detail, never a bare null',
    timeoutMs: 30_000,
    async run(backend) {
      const runtime = createManualRuntimeServices();
      const report = await runCrashScenario({
        runtime,
        backend,
        kind: 'recovery-failure',
        killAtMarker: 'catalog-run-started',
      });

      expectCleanRecoveryShape(report);
      expect(marker(report.first, 'catalog-run-started')).toBeDefined();

      const detail = observation(report.second, 'recovery-failure-detail') as {
        status?: string;
        error?: string;
        failureCategory?: string;
      } | null;
      // Never a bare null: the failure detail (status, error message naming
      // the missing catalog agent, and a failure category) is observable
      // through `bureau.getDurableRun` — the same public surface every
      // other scenario in this matrix reads `final-root-workflow-state`
      // through, never a durable-store read.
      expect(detail).not.toBeNull();
      expect(detail?.status).toBe('failed');
      expect(detail?.error).toContain('crash-fixture-ghost-agent');
      expect(detail?.error).toContain('no longer in the catalog');
      expect(detail?.failureCategory).toBeDefined();
    },
  },
];
