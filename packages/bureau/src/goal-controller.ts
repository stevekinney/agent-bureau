/**
 * COR-851 — what the control plane does to a goal's controller workflow and to
 * the record underneath it, shared by `create`, `cancel`, and `recover`.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  buildGoalForcedFinish,
  type CleanupAcknowledgement,
  decideCancellation,
  decideDeterminismRequirement,
  GOAL_WORKFLOW_TYPE,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowPorts,
} from '@lostgradient/operative';
import { WorkflowAlreadyExistsError } from '@lostgradient/weft';

import type { AttemptForwarder } from './goal-forwarder';
import { goalIdentifiers } from './goal-ports';
import { type GoalState, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type { GoalStore, GoalTransitionResult } from './goal-store';
import type { BureauGoalControllerStart, GoalEngine } from './goal-types';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

/** What the control plane's operations share. */
export interface GoalControlDependencies {
  readonly store: GoalStore;
  /** What the goal's validator promises, for the requirement a goal states about it. */
  readonly catalog: Pick<GoalValidatorCatalog, 'resolve'>;
  readonly clock: Pick<RuntimeServices['clock'], 'now' | 'nowISO'>;
  /** Bounds the one start recovery makes outside the controller's own activity; see `recoverAttempt`. */
  readonly timers: Pick<RuntimeServices['timers'], 'setTimeout' | 'clearTimeout'>;
  readonly diagnose: DiagnosticSink;
  readonly getEngine: () => GoalEngine | undefined;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  readonly forwarder: AttemptForwarder;
  /**
   * The same start-or-adopt the controller's activity uses, for the one recovery
   * that must start a run itself: an attempt the controller recorded as running
   * whose run is gone. See `recoverAttempt`.
   */
  readonly startAttempt: GoalWorkflowPorts['startAttempt'];
  /**
   * Tombstones the claim of an attempt's run (`goal-attempt-fence.ts`), so a
   * start that has claimed the run but not created it starts nothing and a run
   * it does create takes no step. `foreign` is a record that is not this
   * attempt's, left alone. Rejects when it could not be done; the work is then
   * still owed.
   */
  readonly fenceAttempt: (record: GoalState, attemptIndex: number) => Promise<'fenced' | 'foreign'>;
  readonly isClosing: () => boolean;
  /**
   * Aborted when the bureau drains goal work at shutdown. Recovery's own start
   * (`startWithinBudget`) is abandoned at once when it aborts, so a recovery that
   * outlived the boot sweep's budget settles instead of being left running over an
   * engine and storage that are being disposed.
   */
  readonly shutdownSignal?: AbortSignal | undefined;
  /**
   * Applies the bureau's checkpoint retention to a terminal workflow's history
   * (the goal's controller, or one of its attempts' runs) and says truthfully
   * how it went. Never rejects.
   */
  readonly cleanupWorkflow: (workflowId: string) => Promise<CleanupAcknowledgement>;
}

/** Weft's own statuses for a workflow that has stopped for good. */
export const TERMINAL_CONTROLLER_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * Starts the goal's controller under its stable id. With `replaceTerminal`, a
 * controller that already ended is replaced by a fresh one that resumes from
 * the record; a live one is never displaced.
 */
export async function startController(
  engine: GoalEngine,
  goalRunId: string,
  replaceTerminal: boolean,
): Promise<'started' | 'exists'> {
  try {
    await engine.start(
      GOAL_WORKFLOW_TYPE,
      { goalRunId },
      {
        id: goalWorkflowId(goalRunId),
        ...(replaceTerminal ? { onTerminalConflict: 'start-new' as const } : {}),
      },
    );
    return 'started';
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) return 'exists';
    throw error;
  }
}

/**
 * The attempt whose run a cancellation, or an elapsed duration bound, must stop:
 * the one in flight, or else the next one, because a start that died just short
 * of its commit leaves an orphan run under the next attempt's deterministic id.
 * Stopping a run that never existed is a no-op.
 */
export function attemptToStop(record: GoalState): GoalWorkflowAbortRequest {
  const last = record.attempts.at(-1);
  const attemptIndex =
    last !== undefined && (last.status === 'running' || last.status === 'evaluating')
      ? last.attemptIndex
      : record.attempts.length;
  return {
    goalRunId: record.goalRunId,
    attemptIndex,
    attemptId: goalIdentifiers.attemptId(record.goalRunId, attemptIndex),
    runId: goalIdentifiers.attemptRunId(record.goalRunId, attemptIndex),
  };
}

/**
 * The attempts whose runs an ending or a cancellation must see stopped and
 * fenced: the one `attemptToStop` names and, once the goal has moved past it, the
 * attempt that was in flight.
 */
export function attemptIndexesToStop(record: GoalState): readonly number[] {
  const named = attemptToStop(record).attemptIndex;
  const last = record.attempts.at(-1)?.attemptIndex;
  const indexes = last === undefined || last === named ? [named] : [named, last];
  // The controller never opens an attempt at or past `maximumAttempts`, so no
  // start can claim such an index and a tombstone for it would be a record that
  // nothing ever reads or prunes (`cleanUpGoal` retires indexes below the bound).
  return indexes.filter((index) => index < record.bounds.maximumAttempts);
}

/**
 * Tombstones the claim of every attempt `record`'s ending may have overtaken.
 * `true` once every claim is fenced (or foreign, and so not the goal's to fence);
 * `false` when one could not be, which leaves the ending's cleanup owed.
 */
export async function fenceOvertakenAttempts(
  dependencies: Pick<GoalControlDependencies, 'fenceAttempt' | 'diagnose'>,
  record: GoalState,
): Promise<boolean> {
  let allFenced = true;
  for (const attemptIndex of attemptIndexesToStop(record)) {
    try {
      await dependencies.fenceAttempt(record, attemptIndex);
    } catch (error) {
      allFenced = false;
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not fence attempt ${attemptIndex} of goal "${record.goalRunId}"; it is retried at the next boot or recover(): ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }
  return allFenced;
}

/**
 * Commits `canceled` for a goal whose cancellation marker is set, from the
 * record's own current state and with the same builder the controller uses.
 * The host does this when the controller can no longer: `engine.cancel` ends a
 * workflow mid-flight, so nothing inside it is left to commit the transition. A
 * controller that commits the same transition first makes this a `duplicate`.
 */
export async function commitCancellation(
  store: GoalStore,
  record: GoalState,
  nowMs: number,
): Promise<GoalTransitionResult | { readonly status: 'not-needed' }> {
  if (record.status === 'canceled') return { status: 'not-needed' };
  return store.applyTransition(
    buildGoalForcedFinish(record, goalIdentifiers, nowMs, decideCancellation()),
  );
}

/**
 * COR-638: a validator that cannot supply the evidence a goal demands ends it
 * `failed`/`unsupported-validation` before any attempt runs. The check belongs
 * wherever a controller is about to be started, not only where a goal is
 * created: a process can die between writing the record and ending it, and the
 * catalog's descriptor can change in between.
 *
 * Applies only to a goal nothing has happened to yet (`pending`, transition 0).
 * Returns the ended record, or `undefined` when the goal may run. When the
 * failure cannot be recorded because the goal was canceled or ended in the
 * meantime, that record is returned instead (it is not a goal that may run, and
 * it is not `failed`: callers tell the two apart by its status). A validator
 * the catalog no longer holds is not this check's business; the attempt's own
 * validation reports that.
 */
export async function enforceDeterminism(
  dependencies: Pick<GoalControlDependencies, 'store' | 'catalog' | 'clock'>,
  record: GoalState,
): Promise<GoalState | undefined> {
  if (record.status !== 'pending' || record.transitionSeq !== 0) return undefined;
  const resolution = dependencies.catalog.resolve(record.validator);
  if (!resolution.ok) return undefined;
  const unsupported = decideDeterminismRequirement(
    record.requireDeterministicValidation,
    resolution.entry.descriptor.determinism,
  );
  if (unsupported?.kind !== 'fail') return undefined;
  const ended = await dependencies.store.applyTransition({
    goalRunId: record.goalRunId,
    seq: 1,
    transitionId: goalIdentifiers.transitionId(record.goalRunId, 1),
    to: 'failed',
    at: dependencies.clock.nowISO(),
    cause: `fail: ${unsupported.reason}`,
    terminalReason: unsupported.reason,
    ...(unsupported.failureDetail === undefined
      ? {}
      : { failureDetail: unsupported.failureDetail }),
  });
  if (ended.status === 'applied' || ended.status === 'duplicate') return ended.record;
  // A cancellation (or an ending) that landed after the caller read the goal makes
  // the store refuse the failure. That is not a goal that may run: the record it
  // carries no longer wants a controller, and the caller must not start one.
  if (
    (ended.status === 'rejected' || ended.status === 'stale') &&
    (isTerminalGoalStatus(ended.record.status) || ended.record.cancellation !== undefined)
  ) {
    return ended.record;
  }
  return undefined;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Makes sure a goal that is not terminal has its controller: ends it first when
 * its validator cannot supply what it requires, then starts the controller
 * under its stable id (a controller that already exists is left alone). Shared
 * by a new goal and by a repeated `create` for one whose first call died
 * between recording it and starting it.
 */
export async function ensureController(
  dependencies: Pick<
    GoalControlDependencies,
    'store' | 'catalog' | 'clock' | 'diagnose' | 'getEngine'
  >,
  stale: GoalState,
): Promise<{ readonly goal: GoalState; readonly controller: BureauGoalControllerStart }> {
  // The caller's copy may be older than the store's: a cancel or a close can land
  // while the caller awaited something else (a store observer, a repeat's read).
  // A controller started for a goal that has ended, or whose cancellation is
  // recorded, would run history that escapes retention and recovery, so the
  // decision is made on a read taken here, and a goal that no longer wants a
  // controller gets none. Recovery finishes a recorded cancellation.
  const record = await dependencies.store.get(stale.goalRunId);
  if (record === undefined) {
    // Missing or undecodable, not unchanged: the caller's copy is no evidence of
    // what is stored, and a controller for a goal nobody can read has nothing to
    // read its record from. `recover()` starts it once the record is readable.
    return {
      goal: stale,
      controller: {
        status: 'start-failed',
        reason: `The record stored for goal "${stale.goalRunId}" cannot be read, so no controller was started.`,
      },
    };
  }
  if (isTerminalGoalStatus(record.status) || record.cancellation !== undefined) {
    return { goal: record, controller: { status: 'not-needed' } };
  }
  const ended = await enforceDeterminism(dependencies, record);
  if (ended !== undefined) return { goal: ended, controller: { status: 'not-needed' } };
  const engine = dependencies.getEngine();
  if (engine === undefined) {
    return {
      goal: record,
      controller: {
        status: 'start-failed',
        reason: 'There is no durable engine to run a controller.',
      },
    };
  }
  try {
    if ((await startController(engine, record.goalRunId, false)) === 'exists') {
      // A workflow under the controller's id was already there, which is not the
      // same as one running: a controller that ended while its goal was not
      // terminal is still nothing to wait on, and only `recover()` replaces it.
      const existing = await engine.get(goalWorkflowId(record.goalRunId));
      if (existing !== null && TERMINAL_CONTROLLER_STATUSES.has(existing.status)) {
        return {
          goal: record,
          controller: {
            status: 'start-failed',
            reason: `The goal's controller already ended ${existing.status}; recover() restarts it.`,
          },
        };
      }
    }
    return { goal: record, controller: { status: 'started' } };
  } catch (error) {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Goal "${record.goalRunId}" was recorded but its controller did not start; recover() starts it: ${describeError(error)}`,
      cause: error,
    });
    return { goal: record, controller: { status: 'start-failed', reason: describeError(error) } };
  }
}
