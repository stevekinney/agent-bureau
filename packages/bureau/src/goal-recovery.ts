/**
 * COR-851 — `bureau.goals.recover`, and the boot sweep that calls it.
 *
 * A goal's durable record says what it was doing; recovery makes the world
 * agree. For each goal that is not terminal it settles two things, in this
 * order.
 *
 * ## The controller
 *
 * Read the controller workflow's stored state:
 *
 * | state                                   | what recovery does                                  |
 * | --------------------------------------- | --------------------------------------------------- |
 * | no workflow                             | start one (the crash between record and start)      |
 * | running or pending                      | nothing; a controller is alive                      |
 * | running, pending, or suspended, marked  | end it, then commit `canceled` from the host        |
 * | suspended                               | resume it                                           |
 * | cancelled, or a cancellation marker     | commit `canceled` from the host (also with no engine)|
 * | any of the starts above, bureau closing | nothing, `shutting-down`; no restart is spent       |
 * | failed, timed out, or completed early   | restart it from the record, up to a bound           |
 * | its finalizer is still owed, or unread  | restart-pending; not counted; recover() retries it  |
 * | a workflow that is not the goal's       | never touched: it reads as absent (goal-ownership)  |
 *
 * A goal whose `canceled` is already committed is not skipped: its controller
 * or attempt run may still be running if the process that committed it died
 * first, so `recover()` and the boot sweep settle it the way `cancel()` does
 * and answer `already-terminal` only once the read-back finds everything ended.
 *
 * A controller that ended while the goal was not terminal and no one asked it
 * to stop ended abnormally. It is restarted with `onTerminalConflict:
 * 'start-new'`, and the new instance resumes purely from the record. Each
 * restart advances `controllerRestarts`; past `MAXIMUM_CONTROLLER_RESTARTS` the
 * goal is reported `unrecoverable` and left exactly as it is, except that no run
 * is left working for it: its attempt claims are tombstoned and the attempt run is
 * cancelled (`stopOrphanedAttempts`). COR-638's terminal reasons are not extended
 * to cover it. A restart is counted before its controller is started, so a
 * controller found ended at the limit may belong to a final restart another
 * recovery is starting: that is `restart-pending` (a failure in the boot report,
 * so a crash-then-quick-reboot is seen) until `RESTART_START_GRACE_MS` has passed
 * since the count, after which `recover()` gives up on the goal.
 *
 * ## The attempt
 *
 * A goal waiting on an attempt waits for a signal nothing else will send if the
 * process that was forwarding it died. So for a `running` goal recovery reads
 * the attempt's run: one that already ended has its signal sent again (the
 * signal id is stable, so a duplicate is harmless), one that is alive gets a
 * forwarder, and one that never started is started now, by the same
 * start-or-adopt the controller's own activity uses.
 *
 * That start is the one start made outside the controller, and it is kept for a
 * reason. It is reached only for an attempt the controller already recorded as
 * `running` whose run is gone (the run's storage was lost): the controller
 * committed `running` because its start activity returned, and that result is
 * memoized in the controller's history, with no Weft API to redo it, so a
 * restarted or parked controller waits on a signal no run will send. Nothing
 * inside the controller can start the run again. The start is the controller's
 * own port, so it carries every fence the controller's start does: the stand-down
 * reads, the activity-signal check, the claim tombstone, and the run's own fence
 * (`goal-attempt-fence.ts`). It is never the way an attempt is first opened.
 *
 * Being outside the controller's activity it is also outside Weft's bound on
 * one, so `startWithinBudget` gives it the same budget (every try of the start
 * activity) and abandons it when that is spent, reporting the attempt `failed`
 * for the next sweep or `recover()` to retry. That bound is what keeps a start
 * that waits on something that never settles from holding the boot sweep, which
 * `createBureau()` awaits, forever.
 */

import { goalInputFeedbackFor, isAttemptStartFailureDetail } from '@lostgradient/operative';
import { WorkflowTeardownPendingError } from '@lostgradient/weft';

import { GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS } from './goal-attempt-fence';
import {
  runsToStop,
  settleCanceledGoal,
  stopRuns,
  unfinishedAfterCancellation,
} from './goal-cancellation';
import { cleanUpGoal, isCleanupDone } from './goal-cleanup';
import {
  attemptIndexesToStop,
  commitCancellation,
  enforceDeterminism,
  fenceOvertakenAttempts,
  type GoalControlDependencies,
  startController,
  TERMINAL_CONTROLLER_STATUSES,
} from './goal-controller';
import { GoalOwnershipError } from './goal-ownership';
import { goalIdentifiers } from './goal-ports';
import { goalRestartId, type GoalState, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type {
  BureauGoalAttemptRecovery,
  BureauGoalCancellationWait,
  BureauGoalRecoveryEntry,
  BureauGoalRecoveryOutcome,
  BureauGoalRecoveryReport,
} from './goal-types';

/** How many times a goal's controller is restarted before recovery gives up on it. */
export const MAXIMUM_CONTROLLER_RESTARTS = 3;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Recovery began while the bureau was shutting down, so it started nothing. */
const SHUTTING_DOWN: ControllerRecovery = {
  outcome: 'shutting-down',
  detail: 'The bureau is shutting down; the next boot recovers this goal.',
};

interface ControllerRecovery {
  readonly outcome: BureauGoalRecoveryOutcome;
  readonly detail?: string | undefined;
  readonly awaiting?: readonly BureauGoalCancellationWait[] | undefined;
}

/** The controller's own cancellation was requested, or its workflow was cancelled out from under it. */
async function completeCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const { store, clock } = dependencies;
  let marked = record;
  if (marked.cancellation === undefined) {
    // The controller was cancelled with no marker: someone ended its workflow
    // directly. That is an operator's cancellation, so it is recorded as one.
    const now = clock.nowISO();
    const outcome = await store.requestCancellation(
      record.goalRunId,
      { requestedAt: now, reason: 'The goal controller was cancelled.' },
      now,
    );
    // A goal that ended without this marker is over, but one that ended canceled
    // still has what its cancellation stops to be read back, so it is settled
    // exactly as a recorded one is; any other ending leaves nothing to do.
    if (outcome.status === 'rejected' && outcome.record.status !== 'canceled') {
      return { outcome: 'already-terminal' };
    }
    if (
      outcome.status !== 'updated' &&
      outcome.status !== 'unchanged' &&
      outcome.status !== 'rejected'
    ) {
      return { outcome: 'unrecoverable', detail: `cancellation marker: ${outcome.status}` };
    }
    marked = outcome.record;
  }
  const runIds = runsToStop(marked);
  // Fenced, then stopped: see `stopRuns`.
  const fenced = await stopRuns(dependencies, marked);
  const commit = await settleCancellationCommit(dependencies, marked);
  if (commit.kind === 'settled') return commit.outcome;
  // The record says `canceled`; whether the world agrees is a separate read, the
  // same one `cancel()` answers from. A run that could not be stopped keeps the
  // goal pending here rather than being reported done.
  const awaiting = await unfinishedAfterCancellation(
    dependencies.getEngine(),
    record.goalRunId,
    runIds,
    true,
    dependencies.diagnose,
  );
  if (!fenced && !awaiting.includes('attempt-run')) awaiting.push('attempt-run');
  return awaiting.length === 0
    ? { outcome: 'canceled' }
    : {
        outcome: 'cancellation-pending',
        awaiting,
        detail: `Still waiting on: ${awaiting.join(', ')}.`,
      };
}

/**
 * A fresh read taken immediately before a controller is started or replaced.
 * The decision to start was made on a record read before several awaits (the
 * engine's own read, the determinism check, the finalizer), and a cancellation
 * or an ending can land in that gap: starting then would run history that
 * escapes retention, and a replacement would spend a restart on a goal already
 * being canceled. Returns what recovery answers instead of starting, or
 * `undefined` when the goal still wants its controller.
 */
async function standDownIfOvertaken(
  dependencies: GoalControlDependencies,
  goalRunId: string,
): Promise<ControllerRecovery | undefined> {
  const fresh = await dependencies.store.get(goalRunId);
  if (fresh === undefined) {
    return (await dependencies.store.isUnreadable(goalRunId))
      ? { outcome: 'unrecoverable', detail: UNREADABLE_RECORD_DETAIL(goalRunId) }
      : { outcome: 'not-found' };
  }
  if (fresh.cancellation !== undefined)
    return endControllerAndCompleteCancellation(dependencies, fresh);
  return isTerminalGoalStatus(fresh.status) ? { outcome: 'already-terminal' } : undefined;
}

/** Ends the controller's workflow, then completes the cancellation the record asks for. */
async function endControllerAndCompleteCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const engine = dependencies.getEngine();
  const { goalRunId } = record;
  try {
    await engine?.cancel(goalWorkflowId(goalRunId));
  } catch (error) {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Could not cancel the controller of goal "${goalRunId}": ${describe(error)}`,
      cause: error,
    });
  }
  return completeCancellation(dependencies, record);
}

/** How many times a commit that lost to a concurrent writer is retried against the record it lost to. */
const CANCELLATION_COMMIT_ATTEMPTS = 3;

/**
 * Commits the cancellation a record's marker asks for and says what the answer
 * means, for the path with an engine and the path without one alike. Every
 * answer the commit can give is its own case, so a new one fails the compiler.
 *
 * - `committed`: the record says `canceled` (this call or another wrote it);
 *   what the world says is a separate read.
 * - `settled`: the commit cannot end in `canceled` and this is the honest answer.
 */
type CancellationCommit =
  | { readonly kind: 'committed' }
  | { readonly kind: 'settled'; readonly outcome: ControllerRecovery };

async function settleCancellationCommit(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<CancellationCommit> {
  const { store, clock } = dependencies;
  let current = record;
  for (let attempt = 0; attempt < CANCELLATION_COMMIT_ATTEMPTS; attempt += 1) {
    const committed = await commitCancellation(store, current, clock.now());
    switch (committed.status) {
      case 'applied':
      case 'duplicate':
      case 'not-needed':
        return { kind: 'committed' };
      case 'stale':
      case 'rejected':
        // Late, out of order, or conflicting: the record it carries is the
        // authoritative one, so the decision is made again against it.
        if (committed.record.status === 'canceled') return { kind: 'committed' };
        if (isTerminalGoalStatus(committed.record.status)) {
          return { kind: 'settled', outcome: { outcome: 'already-terminal' } };
        }
        if (committed.status === 'rejected') {
          return {
            kind: 'settled',
            outcome: {
              outcome: 'unrecoverable',
              detail: `The cancellation could not be committed: ${committed.reason}.`,
            },
          };
        }
        current = committed.record;
        break;
      case 'missing':
        return { kind: 'settled', outcome: { outcome: 'not-found' } };
      case 'corrupt':
        return {
          kind: 'settled',
          outcome: { outcome: 'unrecoverable', detail: UNREADABLE_RECORD_DETAIL(record.goalRunId) },
        };
    }
  }
  // Every round lost to a concurrent writer and the goal is still not canceled.
  // The marker is recorded and the next sweep commits it.
  return {
    kind: 'settled',
    outcome: {
      outcome: 'cancellation-pending',
      awaiting: ['goal-record'],
      detail: 'The cancellation is recorded, but committing it kept losing to concurrent writers.',
    },
  };
}

/**
 * A recorded cancellation with no durable engine: committing it needs no
 * engine, but everything the engine would have stopped is unread, so a
 * committed record is `cancellation-pending` awaiting the engine, never `canceled`.
 */
async function commitWithoutEngine(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const result = await settleCancellationCommit(dependencies, record);
  return result.kind === 'settled'
    ? result.outcome
    : {
        outcome: 'cancellation-pending',
        awaiting: ['durable-engine'],
        detail: 'The cancellation is recorded, but there is no durable engine to read it back.',
      };
}

/**
 * What recovery does for a goal it gives up on: nothing will ever read an
 * attempt's ending again, so no run may keep working for it. Two things stop
 * one, because each covers what the other cannot.
 *
 * - Tombstoning the claims stops a start still in flight when the last
 *   controller died, and a run past its claim takes no step the next time its own
 *   fence reads it (`goal-attempt-fence.ts`). The fence acts at step boundaries
 *   only.
 * - Cancelling the run stops one that is inside a model or tool call right now,
 *   which no fence can reach until that call returns, and an unbounded call never
 *   does. It goes through the owned canceller (`cancelRun`), which stops only a
 *   run whose recovery record is the goal's own, and is a no-op for a run that
 *   never existed or already ended.
 *
 * The goal is not terminal and stays as it is; `cancel()` does both again.
 * Returns the sentence the outcome's `detail` appends, which says what was done
 * and, honestly, what could not be.
 */
async function stopOrphanedAttempts(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<string> {
  const fenced = await fenceOvertakenAttempts(dependencies, record);
  const cancelled: string[] = [];
  const failures: string[] = [];
  for (const runId of runsToStop(record)) {
    const stopped = await dependencies.cancelRun(runId).catch((error: unknown) => ({
      status: 'failed' as const,
      error,
    }));
    if (stopped.status === 'requested') cancelled.push(runId);
    if (stopped.status === 'failed' || stopped.status === 'unsupported-capability') {
      // A canceller without the capability stopped nothing either: the run may
      // still be working, so it is a run that could not be stopped, not no news.
      const reason =
        stopped.status === 'failed' ? describe(stopped.error) : 'unsupported-capability';
      failures.push(`run "${runId}": ${reason}`);
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${runId}" of goal "${record.goalRunId}", whose controller recovery gave up on; it is retried at the next boot or recover(): ${reason}`,
        ...(stopped.status === 'failed' ? { cause: stopped.error } : {}),
      });
    }
  }
  const parts: string[] = [];
  if (cancelled.length > 0) {
    parts.push(
      `The attempt run${cancelled.length === 1 ? '' : 's'} ${cancelled.map((id) => `"${id}"`).join(', ')} ${cancelled.length === 1 ? 'was' : 'were'} cancelled, because no controller is left to read ${cancelled.length === 1 ? 'its' : 'their'} ending.`,
    );
  }
  if (failures.length > 0) {
    parts.push(
      `A run could not be cancelled and may still be working (${failures.join('; ')}); recover() or cancel() retries it.`,
    );
  }
  if (!fenced) {
    parts.push('A claim could not be tombstoned; recover() or cancel() retries it.');
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/**
 * How long a counted restart that has not started a controller is presumed to be
 * on its way, measured from the restart's own audit entry: the budget a
 * controller's start is given. A recovery that crashed between counting and
 * starting never starts it, so past the grace the restart is spent and the goal
 * is given up on, which is the bound erring toward giving up and never toward a
 * second controller.
 */
export const RESTART_START_GRACE_MS = GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS;

/**
 * Whether the newest counted restart is still waiting to start its controller.
 * It is when the controller found ended is older than that restart's audit entry
 * (a controller the restart started is newer, so the restart was observed and
 * its replacement ended too) and the entry is within `RESTART_START_GRACE_MS`. A
 * controller whose creation time is unknown cannot be told apart, and counts as
 * ended after the restart: the goal is given up on, never held open on a guess.
 */
function finalRestartIsInFlight(
  dependencies: GoalControlDependencies,
  record: GoalState,
  controller: { readonly createdAt?: number | undefined },
): boolean {
  const entry = record.auditLog.find(
    (candidate) =>
      candidate.transitionId === goalRestartId(record.goalRunId, record.controllerRestarts),
  );
  const countedAt = Date.parse(entry?.events[0]?.at ?? '');
  const createdAt = controller.createdAt;
  if (!Number.isFinite(countedAt) || typeof createdAt !== 'number') return false;
  return createdAt < countedAt && dependencies.clock.now() - countedAt < RESTART_START_GRACE_MS;
}

async function recoverController(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const { store, clock, getEngine } = dependencies;
  const engine = getEngine();
  if (engine === undefined) {
    if (record.cancellation !== undefined) return commitWithoutEngine(dependencies, record);
    return { outcome: 'unrecoverable', detail: 'There is no durable engine to run a controller.' };
  }
  const { goalRunId } = record;
  const state = await engine.get(goalWorkflowId(goalRunId));
  if (
    state === null ||
    state.status === 'failed' ||
    state.status === 'timed-out' ||
    state.status === 'completed'
  ) {
    // Nothing below may start, resume, or restart a controller once the bureau
    // has begun shutting down: the engine is being disposed. A marked goal whose
    // controller already ended starts nothing (its cancellation is completed
    // below), so only the cases that would start one stop here.
    if (dependencies.isClosing() && (state === null || record.cancellation === undefined)) {
      return SHUTTING_DOWN;
    }
    // A controller is about to be started for a goal nothing has run yet.
    const ended = await enforceDeterminism(dependencies, record);
    if (ended?.status === 'failed') return { outcome: 'unsupported-validation' };
  }
  if (state === null) {
    const overtaken = await standDownIfOvertaken(dependencies, goalRunId);
    if (overtaken !== undefined) return overtaken;
    return {
      outcome:
        (await startController(engine, goalRunId, false)) === 'started' ? 'started' : 'running',
    };
  }
  if (state.status === 'running' || state.status === 'pending') {
    // A cancellation marker means the goal is ending, and a controller that is
    // alive may be inside an activity that never returns (a validator, a start),
    // where no signal can reach it: the marker is read only at a decision point.
    // So it is ended, and the cancellation completed from the host, exactly as
    // for a suspended controller.
    if (record.cancellation !== undefined) {
      return endControllerAndCompleteCancellation(dependencies, record);
    }
    return { outcome: 'running' };
  }
  if (state.status === 'suspended') {
    if (record.cancellation !== undefined) {
      // A resumed controller would re-park on its attempt signal and the marker
      // in the store never wakes it, so the cancellation it was asked for would
      // hang with the attempt running. Ending the suspended workflow is what
      // `cancel()` does to a controller; the rest is settled the same way.
      return endControllerAndCompleteCancellation(dependencies, record);
    }
    if (dependencies.isClosing()) return SHUTTING_DOWN;
    await engine.resume(goalWorkflowId(goalRunId));
    return { outcome: 'running' };
  }
  if (record.cancellation !== undefined || state.status === 'cancelled') {
    return completeCancellation(dependencies, record);
  }
  if (!TERMINAL_CONTROLLER_STATUSES.has(state.status)) {
    return { outcome: 'running', detail: `controller status ${state.status}` };
  }

  // Failed, timed out, or completed while the goal is not terminal.
  if (record.controllerRestarts >= MAXIMUM_CONTROLLER_RESTARTS) {
    // The count is written before the replacement is started, so a controller
    // that has ended at the limit may be one whose final restart another recovery
    // has counted and is about to start. Giving up on it now would tombstone and
    // cancel the attempt that restart is starting under.
    if (finalRestartIsInFlight(dependencies, record, state)) {
      // `restart-pending`, never `running`: the boot sweep runs once, and a
      // recovery that crashed after counting and rebooted inside the grace leaves
      // a goal with no controller that nothing else revisits. It is reported a
      // failure so that it is seen, and a `recover()` after the grace gives up.
      return {
        outcome: 'restart-pending',
        detail: `Another recovery has counted restart ${record.controllerRestarts} and has not started its controller yet; if it never does, a later recover() gives up on the goal.`,
      };
    }
    return {
      outcome: 'unrecoverable',
      detail: `The controller ended ${state.status} and has already been restarted ${record.controllerRestarts} times.${await stopOrphanedAttempts(dependencies, record)}`,
    };
  }
  // A controller that ended still owes its finalizer until Weft says it does
  // not, and Weft refuses to replace a run in that state. Nothing is counted
  // for a restart that cannot happen yet. Nothing retries it either, so it is
  // reported `restart-pending` (a failure in the boot report), and the next
  // `recover()` tries again. A finalizer that cannot be read is no evidence it
  // is settled: restarting on it would spend a count on a restart Weft refuses.
  let finalizer: Awaited<ReturnType<typeof engine.getFinalizerStatus>>;
  try {
    finalizer = await engine.getFinalizerStatus(goalWorkflowId(goalRunId));
  } catch (error) {
    return {
      outcome: 'restart-pending',
      detail: `The controller ended ${state.status} and its finalizer could not be read: ${describe(error)}`,
    };
  }
  if (finalizer !== null && (finalizer.status === 'pending' || finalizer.status === 'running')) {
    return {
      outcome: 'restart-pending',
      detail: `The controller ended ${state.status} and its finalizer is still ${finalizer.status}; recover() restarts it once that settles.`,
    };
  }
  // A shutdown that began while the finalizer was read must not consume a
  // restart for a controller that cannot be started. The window after this check,
  // between the count and the start, is a few awaits wide.
  if (dependencies.isClosing()) return SHUTTING_DOWN;
  const overtaken = await standDownIfOvertaken(dependencies, goalRunId);
  if (overtaken !== undefined) return overtaken;
  // The count is a compare-and-swap on the value this recovery read, so of
  // several recoveries that saw the same ended controller exactly one is
  // counted, and only that one starts a replacement. A restart counted but
  // never started (a crash between the two) is spent: the bound errs toward
  // giving up, never toward a second controller.
  const counted = await store.recordControllerRestart(
    goalRunId,
    clock.nowISO(),
    record.controllerRestarts,
  );
  if (counted.status === 'rejected') {
    // A cancellation that landed after this recovery's read is not a restart to
    // spend: the store refuses it, and the cancellation is completed instead.
    if (counted.reason === 'cancellation-requested') {
      return endControllerAndCompleteCancellation(dependencies, counted.record);
    }
    // Only a terminal goal is done. A full audit log leaves the goal running
    // with no controller and no room to record a restart: that is a goal
    // recovery gave up on, and it must not read as one that ended.
    if (counted.reason === 'terminal') return { outcome: 'already-terminal' };
    return {
      outcome: 'unrecoverable',
      detail: `The controller ended ${state.status}, but the goal's audit log has no room to record a restart.${await stopOrphanedAttempts(dependencies, record)}`,
    };
  }
  if (counted.status === 'stale') {
    return { outcome: 'running', detail: 'Another recovery is restarting the controller.' };
  }
  if (counted.status !== 'updated') {
    return { outcome: 'unrecoverable', detail: `restart count: ${counted.status}` };
  }
  // The count above is a write, and a cancellation can land after it and before
  // the start. The restart is spent, as the bound errs toward giving up, but no
  // replacement is started for a goal that no longer wants one.
  const raced = await standDownIfOvertaken(dependencies, goalRunId);
  if (raced !== undefined) return raced;
  let started: 'started' | 'exists';
  try {
    started = await startController(engine, goalRunId, true);
  } catch (error) {
    // A teardown that began between the readiness check above and this start.
    // That window is a few reads wide, and the count it spends is the one cost
    // of closing it: the check, not a refund, is what keeps a pending teardown
    // from consuming the bound.
    if (error instanceof WorkflowTeardownPendingError) {
      return {
        outcome: 'restart-pending',
        detail: `The restart waits for the controller's teardown: ${error.message}`,
      };
    }
    throw error;
  }
  return {
    outcome: started === 'started' ? 'restarted' : 'running',
    detail: `The controller ended ${state.status}${state.error === undefined ? '' : `: ${state.error}`}.`,
  };
}

/**
 * The recovery start runs outside the controller's activity, and so outside the
 * bound Weft puts on that activity: a start that waits on something that never
 * settles (a durable resolver, a store) would hold `recover()` and, through the
 * boot sweep, `createBureau()` forever. It gets the controller's own budget,
 * every try of the start activity (`GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS`),
 * and is abandoned when that is spent. Abandoning is what Weft does to a try it
 * times out: its signal is aborted, so the port writes nothing further and
 * creates no run it has not already created (the next start adopts one that
 * exists), and nothing waits for it. `timed-out` is reported as an attempt that
 * could not be reconciled, which the boot report counts as a failure, and the
 * next sweep or `recover()` tries again.
 */
async function startWithinBudget(
  dependencies: GoalControlDependencies,
  request: Parameters<GoalControlDependencies['startAttempt']>[0],
): Promise<Awaited<ReturnType<GoalControlDependencies['startAttempt']>> | 'timed-out'> {
  const { timers, diagnose } = dependencies;
  const abandon = new AbortController();
  let handle: ReturnType<typeof timers.setTimeout>;
  let resolveExpired!: (outcome: 'timed-out') => void;
  const expired = new Promise<'timed-out'>((resolve) => {
    resolveExpired = resolve;
    handle = timers.setTimeout(() => {
      abandon.abort();
      resolve('timed-out');
    }, GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
  });
  // Shutdown abandons the start as an expired budget does: the abandoned start
  // writes nothing further, and nothing waits for it.
  const onShutdown = (): void => {
    abandon.abort();
    resolveExpired('timed-out');
  };
  const shutdown = dependencies.shutdownSignal;
  if (shutdown?.aborted === true) onShutdown();
  else shutdown?.addEventListener('abort', onShutdown, { once: true });
  const start = dependencies.startAttempt(request, abandon.signal);
  // A start that fails after it was abandoned has no caller left to reject to.
  start.catch((error: unknown) => {
    if (!abandon.signal.aborted) return;
    // The port rejecting because recovery aborted it is the abandonment working,
    // not a late failure.
    if (error === abandon.signal.reason) return;
    if (error instanceof Error && error.name === 'AbortError') return;
    diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] The abandoned start of attempt ${request.attemptIndex} of goal "${request.goalRunId}" failed: ${describe(error)}`,
      cause: error,
    });
  });
  try {
    return await Promise.race([start, expired]);
  } finally {
    shutdown?.removeEventListener('abort', onShutdown);
    timers.clearTimeout(handle);
  }
}

/** Reconciles the attempt a `running` goal is waiting on. */
async function recoverAttempt(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<{ attempt?: BureauGoalAttemptRecovery; detail?: string }> {
  const { store, forwarder } = dependencies;
  const current = (await store.get(record.goalRunId)) ?? record;
  const last = current.attempts.at(-1);
  if (current.status !== 'running' || last === undefined || last.status !== 'running') return {};
  const target = {
    goalRunId: current.goalRunId,
    attemptIndex: last.attemptIndex,
    runId: last.runId,
  };
  const reconciled = await forwarder.reconcile(target);
  if (reconciled === 'watching') return { attempt: 'watching' };
  if (reconciled === 'signal-resent') return { attempt: 'signal-resent' };
  if (reconciled === 'not-needed') return {};

  // No run exists under the attempt's id. The controller recorded the attempt as
  // started, so the run was lost with its workflow before it could be recovered;
  // start it again, exactly as the controller's own activity would have, unless
  // the bureau is shutting down, when no run may be started.
  if (dependencies.isClosing()) {
    return { detail: 'The attempt was not restarted: the bureau is shutting down.' };
  }
  const feedback = goalInputFeedbackFor(current.attempts, last.attemptIndex);
  const started = await startWithinBudget(dependencies, {
    goalRunId: current.goalRunId,
    attemptIndex: last.attemptIndex,
    attemptId: goalIdentifiers.attemptId(current.goalRunId, last.attemptIndex),
    runId: last.runId,
    ...(feedback === undefined ? {} : { feedback }),
  });
  if (started === 'timed-out') {
    return {
      attempt: 'failed',
      detail: `The attempt's run was not restarted: its start did not settle within ${GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS} ms, so it was abandoned (a start that was past its own checks still adopts what it created); recover() tries again.`,
    };
  }
  if (started.status === 'stood-down') {
    // The goal was canceled, ended, or ran out of its duration; nothing was
    // created, and the controller ends the goal from the record.
    return { detail: 'The attempt was not restarted: the goal is over or out of time.' };
  }
  return started.status === 'failed'
    ? { attempt: 'failed', detail: started.detail }
    : { attempt: 'run-started' };
}

/**
 * Finishes what a committed `canceled` leaves to do, and answers the way
 * `cancel()` would: `already-terminal` when everything is settled, otherwise
 * `cancellation-pending` naming what is not.
 */
async function settleCommittedCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry> {
  const settled = await settleCanceledGoal(dependencies, record);
  if (settled.outcome === 'not-found') return { goalRunId: record.goalRunId, outcome: 'not-found' };
  if (settled.outcome === 'record-unreadable') {
    return {
      goalRunId: record.goalRunId,
      outcome: 'unrecoverable',
      detail: UNREADABLE_RECORD_DETAIL(record.goalRunId),
    };
  }
  if (settled.outcome === 'cancellation-pending') {
    return {
      goalRunId: record.goalRunId,
      outcome: 'cancellation-pending',
      awaiting: settled.awaiting,
      detail: `Still waiting on: ${settled.awaiting.join(', ')}.`,
    };
  }
  return { goalRunId: record.goalRunId, outcome: 'already-terminal' };
}

/** A closure was committed but the cleanup it owes was not recorded as finished. */
const owesCleanup = (record: GoalState): boolean =>
  record.closedAt !== undefined && record.cleanedUpAt === undefined;

/**
 * An ending that can leave a run behind. The controller never abandons a start
 * it issued (it waits for the start activity to settle), so it knows the run it
 * must stop, and stops it before it commits the ending. What it cannot know
 * about is a start it did not wait for: a try Weft timed out that is still
 * running in the background, or the host's own recovery start, which creates
 * its run after the goal ended, or a process that dies after the engine's start
 * committed the run and before the start's own stand-down check stopped it.
 * Either leaves a run alive under a goal that is already terminal. A start can
 * be in flight when the goal is canceled, when its aggregate duration runs out,
 * and when the start itself ends the goal `failed` (`attempt-run-failed`, from a
 * start-failure commit), so those three are swept; a goal that failed for any
 * other reason, or succeeded, ended after every start it issued had settled.
 * A goal that is still running whose controller recovery gave up on
 * (`unrecoverable`) is not terminal and is reported at every boot. Recovery
 * tombstones the claims of the attempts it may have overtaken when it gives up,
 * so a run such a start leaves takes no step; `cancel()` or `close()` stops it.
 */
export const mayHaveOvertakenAStart = (record: GoalState): boolean =>
  record.status === 'canceled' ||
  record.status === 'exhausted' ||
  (record.status === 'failed' &&
    record.terminalReason === 'attempt-run-failed' &&
    isAttemptStartFailureDetail(record.failureDetail));

/** Whether a record still has anything for recovery to do. */
const needsRecovery = (record: GoalState): boolean =>
  !isTerminalGoalStatus(record.status) ||
  (mayHaveOvertakenAStart(record) && record.closedAt === undefined) ||
  owesCleanup(record);

/**
 * Settles the attempts an exhausted or start-failed goal's ending may have
 * overtaken, the defense in depth behind the controller's refusal to abandon a
 * start. The goal is terminal and its controller is done, so nothing but this
 * will ever name those attempts again. It covers two named crash points, in this
 * order.
 *
 * - Fence: a start that has claimed its run but not yet created it (in a
 *   background try still alive in this process, or in a process that died there)
 *   looks absent to every read, and no read can prove it will not appear: the
 *   engine's start takes no precondition on the claim. So the attempt's claim is
 *   tombstoned first. A start that claims afterwards finds the tombstone and
 *   starts nothing, and a run that was already past its claim takes no step,
 *   because its own fence reads the tombstone (`goal-attempt-fence.ts`). A claim
 *   that cannot be tombstoned is reported and stays owed.
 * - Stop: a start's run was created (the engine's start committed) but the
 *   process died, or a timed-out background try ran on, before the start's own
 *   stand-down check stopped it, after the goal had already ended. A run that is
 *   alive is cancelled, so it does not run on after its goal.
 *
 * `runsToStop` names the in-flight attempt's run, or the next attempt's
 * deterministic id for a start that died short of its commit. A run that does not
 * exist or has ended is left alone; one that cannot be read or stopped is
 * reported, and stays owed until the next boot or `recover()`, and so is every
 * run while there is no engine to read one with. A canceled goal is settled the
 * same way by `settleCommittedCancellation`. `close()` runs it first, because a
 * closed and cleaned goal leaves the sweep.
 */
export async function stopOvertakenRuns(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry> {
  const engine = dependencies.getEngine();
  // A run it may have left cannot be inspected without an engine, so the goal
  // is not reported done: it stays in the sweep until one can be read.
  if (engine === undefined) {
    return {
      goalRunId: record.goalRunId,
      outcome: 'cleanup-pending',
      detail:
        'The goal ended, but there is no durable engine to look for a run its ending may have overtaken.',
    };
  }
  const failures: string[] = [];
  // Fenced before any run is looked for: an absent run is not proof that none
  // will appear (a start that has claimed its run but not created it looks
  // absent), and the tombstone is what makes the run such a start goes on to
  // create take no step. Only once every claim is tombstoned is a run that is
  // absent now owed nothing.
  for (const attemptIndex of attemptIndexesToStop(record)) {
    try {
      await dependencies.fenceAttempt(record, attemptIndex);
    } catch (error) {
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not fence attempt ${attemptIndex} of goal "${record.goalRunId}", whose ending may have overtaken its start; it is retried at the next boot or recover(): ${describe(error)}`,
        cause: error,
      });
      failures.push(`attempt ${attemptIndex}'s claim: ${describe(error)}`);
    }
  }
  for (const runId of runsToStop(record)) {
    try {
      const run = await engine.get(runId);
      if (run === null || TERMINAL_CONTROLLER_STATUSES.has(run.status)) continue;
      const stopped = await dependencies.cancelRun(runId);
      if (stopped.status === 'failed') throw stopped.error;
      // No capability to cancel with stopped nothing: the run may still be working.
      if (stopped.status === 'unsupported-capability') throw new Error('unsupported-capability');
    } catch (error) {
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${runId}", which the ending of goal "${record.goalRunId}" overtook; it is retried at the next boot or recover(): ${describe(error)}`,
        cause: error,
      });
      failures.push(`run "${runId}": ${describe(error)}`);
    }
  }
  return failures.length === 0
    ? { goalRunId: record.goalRunId, outcome: 'already-terminal' }
    : {
        goalRunId: record.goalRunId,
        outcome: 'cleanup-pending',
        detail: `The goal ended, but a run its ending overtook could not be stopped (${failures.join('; ')}).`,
      };
}

/**
 * Finishes the checkpoint cleanup a closed goal still owes: the process that
 * committed the closure died before it finished, or a part could not be pruned
 * then. Recorded on the goal only once nothing is left owed, so a part that
 * still cannot be pruned is tried again by the next boot or `close()`, and says
 * so: the entry it returns is `cleanup-pending`, which the boot report counts as
 * a failure. `undefined` when nothing is owed any longer.
 */
async function finishOwedCleanup(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry | undefined> {
  if (!owesCleanup(record)) return undefined;
  // Pruning is not started once the bureau is shutting down, and the cleanup is
  // still owed, so the goal must not read as finished: the next boot finishes it.
  if (dependencies.isClosing()) return { goalRunId: record.goalRunId, ...SHUTTING_DOWN };
  const cleanup = await cleanUpGoal(dependencies, record);
  if (isCleanupDone(cleanup)) {
    const marked = await dependencies.store.markCleanedUp(
      record.goalRunId,
      dependencies.clock.nowISO(),
    );
    if (marked.status === 'updated' || marked.status === 'unchanged') return undefined;
    // The pruning is done, but that was not recorded, so the goal still owes it as
    // far as every later read can tell: it is not finished, and the next boot or
    // close() records it.
    return {
      goalRunId: record.goalRunId,
      outcome: 'cleanup-pending',
      detail: `The closed goal's checkpoint cleanup finished, but recording it did not (${marked.status}); the next boot or close() records it.`,
    };
  }
  const reason =
    dependencies.getEngine() === undefined
      ? 'there is no durable engine to prune it with'
      : cleanup.status === 'failed'
        ? describe(cleanup.error)
        : `it is unresolved (${cleanup.status === 'unresolved' ? cleanup.reason : 'unknown'})`;
  if (cleanup.status === 'failed') {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Could not apply checkpoint retention to the closed goal "${record.goalRunId}"; it is retried at the next boot or close(): ${describe(cleanup.error)}`,
      cause: cleanup.error,
    });
  }
  return {
    goalRunId: record.goalRunId,
    outcome: 'cleanup-pending',
    detail: `The closed goal's checkpoint cleanup is not finished: ${reason}.`,
  };
}

/**
 * How long the boot sweep holds `createBureau()` for goals that have not
 * finished recovering, however many there are. It is well under one start's own
 * budget (`GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS`): recovery that is simply
 * working finishes long before it, and one stuck on a resolver or a store that
 * never settles is not worth a bureau that cannot be used.
 */
export const GOAL_BOOT_SWEEP_BUDGET_MS = 30_000;

/** How many goals the sweep recovers at once, so one stuck goal does not hold the rest back. */
const SWEEP_CONCURRENCY = 4;

export interface RecoverEveryGoalOptions {
  /**
   * Returns once this long has passed even if goals are still recovering. Each
   * goal still recovering is reported as a failure, and carries on in the
   * background (its own start budget, shutdown, and `recover()` bound it); a
   * result it reaches later is not added to the report. Unset, the sweep waits
   * for every goal.
   */
  readonly budgetMs?: number;
  /**
   * Handed the work still running when the budget ended, as a promise that never
   * rejects and settles once every goal has stopped recovering, so a caller that
   * must not leave it running (the bureau at shutdown) can await it. Not called
   * when the sweep finished inside its budget.
   */
  readonly onBackground?: (settled: Promise<void>) => void;
}

/** Recovers one goal. Never throws. */
export async function recoverGoal(
  dependencies: GoalControlDependencies,
  goalRunId: string,
): Promise<BureauGoalRecoveryEntry> {
  const record = await dependencies.store.get(goalRunId);
  if (record === undefined) return { goalRunId, outcome: 'not-found' };
  if (isTerminalGoalStatus(record.status)) {
    // A goal whose `canceled` is committed may still have its controller or
    // attempt run to stop, if the process that committed it died first.
    const settled: BureauGoalRecoveryEntry =
      record.status === 'canceled'
        ? await settleCommittedCancellation(dependencies, record)
        : mayHaveOvertakenAStart(record)
          ? await stopOvertakenRuns(dependencies, record)
          : { goalRunId, outcome: 'already-terminal' };
    // Only once nothing is left to stop: pruning a history something still reads would lose it.
    if (settled.outcome === 'already-terminal') {
      return (await finishOwedCleanup(dependencies, record)) ?? settled;
    }
    return settled;
  }
  let controller: ControllerRecovery;
  try {
    controller = await recoverController(dependencies, record);
  } catch (error) {
    // Something that is not the goal's controller holds its workflow id: it was
    // left alone, and the goal cannot run until that is resolved.
    if (error instanceof GoalOwnershipError) {
      return { goalRunId, outcome: 'unrecoverable', detail: error.message };
    }
    throw error;
  }
  if (
    controller.outcome === 'unrecoverable' ||
    controller.outcome === 'already-terminal' ||
    controller.outcome === 'not-found'
  ) {
    return { goalRunId, ...controller };
  }
  if (
    controller.outcome === 'canceled' ||
    controller.outcome === 'cancellation-pending' ||
    controller.outcome === 'restart-pending' ||
    controller.outcome === 'shutting-down' ||
    controller.outcome === 'unsupported-validation'
  ) {
    return { goalRunId, ...controller };
  }
  const attempt = await recoverAttempt(dependencies, record).catch((error: unknown) => ({
    attempt: 'failed' as const,
    detail: describe(error),
  }));
  return {
    goalRunId,
    outcome: controller.outcome,
    ...(attempt.attempt === undefined ? {} : { attempt: attempt.attempt }),
    ...(attempt.detail === undefined && controller.detail === undefined
      ? {}
      : { detail: [controller.detail, attempt.detail].filter(Boolean).join(' ') }),
  };
}

export const UNREADABLE_RECORD_DETAIL = (goalRunId: string): string =>
  `The record stored for goal "${goalRunId}" is unreadable, so recovery cannot tell what it was doing.`;

/**
 * A recovery that ends after the boot report was given has no report left to
 * land in, so a failure of it is diagnosed here rather than dropped.
 */
function diagnoseLateRecovery(
  dependencies: GoalControlDependencies,
  goalRunId: string,
  result: BureauGoalRecoveryEntry | { readonly failure: string } | 'quiet',
): void {
  if (result === 'quiet') return;
  const reason = 'failure' in result ? result.failure : recoveryEntryFailure(result);
  if (reason === undefined) return;
  dependencies.diagnose({
    level: 'error',
    scope: 'goals',
    message: `[bureau] Recovery of goal "${goalRunId}" ended after the boot sweep's report was given, and failed: ${reason}`,
  });
}

/** The boot sweep: every goal that is not terminal, and every canceled one not yet closed, whose cleanup may be owed. */
export async function recoverEveryGoal(
  dependencies: GoalControlDependencies,
  /** Narrows the sweep to the goals the caller may see; every goal when omitted. */
  allows: (record: GoalState) => boolean = () => true,
  /**
   * Also report the records that cannot be decoded as failures. They have no
   * principal to check, so this is for a caller who may see every goal.
   */
  includeUnreadable = false,
  options: RecoverEveryGoalOptions = {},
): Promise<BureauGoalRecoveryReport> {
  const goals: BureauGoalRecoveryEntry[] = [];
  const failures: { goalRunId: string; reason: string }[] = [];
  let records: GoalState[];
  try {
    const scanned = await dependencies.store.scan();
    records = scanned.records.filter((record) => needsRecovery(record) && allows(record));
    if (includeUnreadable) {
      for (const goalRunId of scanned.unreadable) {
        failures.push({ goalRunId, reason: UNREADABLE_RECORD_DETAIL(goalRunId) });
      }
    }
  } catch (error) {
    return { goals, failures: [{ goalRunId: '*', reason: describe(error) }] };
  }
  // With nothing to recover the sweep ends without another turn of the event
  // loop: boot runs it after the engine resumes its runs, and a turn spent here
  // is one those runs' first events can be lost in (COR-1421).
  if (records.length === 0) return { goals, failures };
  // Recovered a few at a time, each result kept at its goal's place in the
  // order, so the report reads the same however the goals interleave.
  const entries = new Map<
    number,
    BureauGoalRecoveryEntry | { readonly failure: string } | 'quiet'
  >();
  let reported = false;
  const started = new Set<number>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < records.length) {
      const index = next;
      next += 1;
      started.add(index);
      const record = records[index]!;
      let result: BureauGoalRecoveryEntry | { readonly failure: string } | 'quiet';
      try {
        const entry = await recoverGoal(dependencies, record.goalRunId);
        // A canceled goal is in the sweep only to have its cleanup finished; one
        // with nothing left to finish is no more news than any other ended goal.
        result =
          isTerminalGoalStatus(record.status) && entry.outcome === 'already-terminal'
            ? 'quiet'
            : entry;
      } catch (error) {
        result = { failure: describe(error) };
      }
      if (!reported) entries.set(index, result);
      else diagnoseLateRecovery(dependencies, record.goalRunId, result);
    }
  }
  const everyGoal = Promise.all(
    Array.from({ length: Math.min(SWEEP_CONCURRENCY, records.length) }, worker),
  );
  const budgetMs = options.budgetMs;
  let overBudget = false;
  if (budgetMs === undefined) {
    await everyGoal;
  } else {
    const { timers } = dependencies;
    let handle: ReturnType<typeof timers.setTimeout>;
    const expired = new Promise<'expired'>((resolve) => {
      handle = timers.setTimeout(() => resolve('expired'), budgetMs);
    });
    try {
      overBudget =
        (await Promise.race([everyGoal.then(() => 'done' as const), expired])) === 'expired';
    } finally {
      timers.clearTimeout(handle);
    }
  }
  reported = true;
  if (overBudget)
    options.onBackground?.(
      everyGoal.then(
        () => undefined,
        () => undefined,
      ),
    );
  for (const [index, record] of records.entries()) {
    const result = entries.get(index);
    if (result === undefined) {
      // Nothing recorded for it: recovery had not finished when the budget ended.
      if (overBudget) {
        failures.push({
          goalRunId: record.goalRunId,
          reason: started.has(index)
            ? `The goal was still recovering when the boot sweep's ${budgetMs} ms budget ended; recovery carries on in the background, and recover() reports where it stands.`
            : `Recovery of the goal had not started when the boot sweep's ${budgetMs} ms budget ended, because every recovery slot was held by a goal that had not settled; recover() retries it.`,
        });
      }
    } else if (result === 'quiet') {
      continue;
    } else if ('failure' in result) {
      failures.push({ goalRunId: record.goalRunId, reason: result.failure });
    } else {
      goals.push(result);
    }
  }
  return { goals, failures };
}

/**
 * The sweep `createBureau()` runs at boot: every goal, including the records
 * that cannot be decoded, held to `GOAL_BOOT_SWEEP_BUDGET_MS` so a stuck goal
 * never keeps the bureau from being returned.
 */
export function recoverGoalsAtBoot(
  dependencies: GoalControlDependencies,
  options: Pick<RecoverEveryGoalOptions, 'onBackground'> = {},
): Promise<BureauGoalRecoveryReport> {
  return recoverEveryGoal(dependencies, () => true, true, {
    ...options,
    budgetMs: GOAL_BOOT_SWEEP_BUDGET_MS,
  });
}

/**
 * Why an entry of a recovery report is a failure rather than news, or
 * `undefined` when it is not one. The boot report folds these into its
 * per-run failures, so `waitForRecovery()` does not read clean over a goal that
 * is stuck: one recovery gave up on, one with no controller and nothing to
 * restart it, one whose attempt could not be reconciled, one that has ended but
 * owes cleanup (a closure's pruning, or a run its ending overtook) it could not
 * finish, or a cancellation that cannot settle (a dead-lettered finalizer, or no
 * engine to read it with).
 * A cancellation still waiting on a controller, finalizer, or run in progress is
 * not one: those finish on their own.
 */
export function recoveryEntryFailure(entry: BureauGoalRecoveryEntry): string | undefined {
  const reason = (fallback: string): string => entry.detail ?? fallback;
  if (entry.outcome === 'unrecoverable') return reason('The goal could not be recovered.');
  if (entry.outcome === 'restart-pending') {
    return reason('The controller ended and its restart is pending.');
  }
  if (entry.outcome === 'cleanup-pending') {
    return reason("The ended goal's cleanup is not finished.");
  }
  if (entry.attempt === 'failed') {
    return reason("The goal's attempt could not be reconciled.");
  }
  if (
    entry.outcome === 'cancellation-pending' &&
    entry.awaiting?.some((wait) => wait === 'finalizer-failed' || wait === 'durable-engine')
  ) {
    return reason('The cancellation cannot settle.');
  }
  return undefined;
}
