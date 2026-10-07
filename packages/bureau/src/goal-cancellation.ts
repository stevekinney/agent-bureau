/**
 * COR-851 — `bureau.goals.cancel`.
 *
 * Cancellation is durable before it is anything else. The marker written to the
 * goal's record is authoritative: once it is there the store accepts no
 * transition but `canceled`, so no late controller write can overtake it.
 * Everything after that makes the rest of the world agree, in this order:
 *
 * 1. Wake the controller with the `cancel` signal. An optimisation: a
 *    controller that was parked commits `canceled` itself.
 * 2. `engine.cancel` the controller workflow, and await its durable commit. It
 *    ends the generator mid-flight, so a controller that had not yet acted on
 *    the signal never will.
 * 3. Tombstone the claim of each attempt the cancellation may have overtaken,
 *    then stop its run (`cancelDurableRun`, idempotent). A start that has claimed
 *    its run but not created it leaves nothing to stop, so the tombstone, not the
 *    stop, is what makes the run it goes on to create take no step
 *    (`goal-attempt-fence.ts`). A claim that cannot be tombstoned is an
 *    `attempt-run` still awaited.
 * 4. Commit `canceled` from the host, with the controller's own builder. A
 *    controller that already did leaves this a `duplicate`.
 * 5. One fresh read of everything that must be finished: the goal record, the
 *    controller's terminal status, its finalizer, and the attempt's run.
 *
 * A goal whose record already says `canceled` is not finished by that alone: a
 * `cancel()` that answered `cancellation-pending` is retried on exactly that
 * premise. It skips the marker and the commit, stops the attempt runs again,
 * and answers from the same read-back, so `already-terminal` is reserved for a
 * goal that ended for some other reason.
 *
 * A bureau with no durable engine (`durableExecution: false` over a store that
 * still holds goals) cannot do steps 1 to 3 or read anything in step 5, so it
 * records the marker and the commit and answers `cancellation-pending`
 * awaiting `durable-engine`; it never claims a workflow-level acknowledgement.
 *
 * There is no polling after step 2. What the read finds in step 5 is the answer:
 * every condition terminal is `canceled`, anything else is
 * `cancellation-pending` and names what it saw unfinished, because
 * `engine.cancel` having resolved is not proof that a cancellation committed.
 * The finalizer is read as the engine reports it: no finalizer owed (`null`, a
 * controller that ended on its own) or `succeeded` is settled; `pending` and
 * `running` are `finalizer`; `failed` is `finalizer-failed`, named apart because
 * the engine has dead-lettered it and will not retry, so waiting cannot settle it.
 * A failed finalizer is never answered `canceled`.
 */

import { GOAL_CANCEL_SIGNAL } from '@lostgradient/operative';

import {
  attemptIndexesToStop,
  commitCancellation,
  fenceOvertakenAttempts,
  type GoalControlDependencies,
  TERMINAL_CONTROLLER_STATUSES,
} from './goal-controller';
import { goalIdentifiers } from './goal-ports';
import { cancelSignalId, type GoalState, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type {
  BureauGoalCancellationWait,
  BureauGoalCancelOptions,
  BureauGoalCancelOutcome,
  GoalEngine,
} from './goal-types';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Performs a cancellation the caller has already authorized against `record`. */
export async function cancelGoal(
  dependencies: GoalControlDependencies,
  record: GoalState,
  options: BureauGoalCancelOptions,
): Promise<BureauGoalCancelOutcome> {
  const { store, clock, diagnose, getEngine } = dependencies;
  const { goalRunId } = record;
  const scoped = options.principal !== undefined;
  if (record.status === 'canceled') return settleCanceledGoal(dependencies, record, { scoped });
  if (isTerminalGoalStatus(record.status)) return { outcome: 'already-terminal', goal: record };

  const now = clock.nowISO();
  const marked = await store.requestCancellation(
    goalRunId,
    {
      requestedAt: now,
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
    now,
  );
  if (marked.status === 'corrupt') {
    // The record decoded a moment ago and no longer does; only a caller who may
    // see every goal is told so.
    return options.principal === undefined
      ? { outcome: 'record-unreadable' }
      : { outcome: 'not-found' };
  }
  if (marked.status === 'missing') return { outcome: 'not-found' };
  if (marked.status === 'rejected') {
    // The goal ended between the caller's read and the marker. One that ended
    // canceled is read back like any other; one that ended otherwise is done.
    return marked.record.status === 'canceled'
      ? settleCanceledGoal(dependencies, marked.record, { scoped })
      : { outcome: 'already-terminal', goal: marked.record };
  }
  // The store retried the write against concurrent writers and lost every
  // round. Nothing was recorded, so nothing will cancel the goal.
  if (marked.status === 'stale') return { outcome: 'contended', goal: marked.record };

  const engine = getEngine();
  const workflowId = goalWorkflowId(goalRunId);
  const attempts = runsToStop(marked.record);
  let fenced = true;
  if (engine !== undefined) {
    // Each step is attempted whatever the one before did: a failure leaves the
    // marker in place and shows up as something unfinished in the read-back.
    try {
      await engine.signal(
        workflowId,
        GOAL_CANCEL_SIGNAL,
        {},
        { signalId: cancelSignalId(goalRunId) },
      );
    } catch {
      // Only an optimisation; the controller may already be gone.
    }
    try {
      await engine.cancel(workflowId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not cancel the controller of goal "${goalRunId}": ${describe(error)}`,
        cause: error,
      });
    }
    fenced = await stopRuns(dependencies, marked.record);
  }
  const latest = (await store.get(goalRunId)) ?? marked.record;
  if (!isTerminalGoalStatus(latest.status)) {
    await commitCancellation(store, latest, clock.now());
  }

  return readBack(dependencies, goalRunId, attempts, scoped, fenced);
}

/**
 * Finishes what a committed `canceled` leaves to do. The marker and the commit
 * are done; the controller and the attempt runs may not be, so each is stopped
 * again (a no-op for one already stopped) and the answer comes from the read.
 * `scoped` is whether the caller may see only its own goals, which hides a
 * record fault behind `not-found`, as every other verb does.
 */
export async function settleCanceledGoal(
  dependencies: GoalControlDependencies,
  record: GoalState,
  viewer: { readonly scoped?: boolean | undefined } = {},
): Promise<BureauGoalCancelOutcome> {
  const { getEngine, diagnose } = dependencies;
  const { goalRunId } = record;
  const engine = getEngine();
  const attempts = runsToStop(record);
  let fenced = true;
  if (engine !== undefined) {
    const controller = await engine.get(goalWorkflowId(goalRunId)).catch(() => undefined);
    if (
      controller !== undefined &&
      controller !== null &&
      !TERMINAL_CONTROLLER_STATUSES.has(controller.status)
    ) {
      try {
        await engine.cancel(goalWorkflowId(goalRunId));
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'goals',
          message: `[bureau] Could not cancel the controller of goal "${goalRunId}": ${describe(error)}`,
          cause: error,
        });
      }
    }
    fenced = await stopRuns(dependencies, record);
  }
  return readBack(dependencies, goalRunId, attempts, viewer.scoped === true, fenced);
}

/**
 * Every run a cancellation of `record` must see stopped: the one `attemptToStop`
 * names, and, once the goal has moved past it, the attempt that was in flight.
 */
export function runsToStop(record: GoalState): readonly string[] {
  // The same indexes the claims are fenced for, so an exhausted goal, whose next
  // index is one no start can mint, names no run that cannot exist.
  return attemptIndexesToStop(record).map((attemptIndex) =>
    goalIdentifiers.attemptRunId(record.goalRunId, attemptIndex),
  );
}

/**
 * Fences every attempt's claim and then stops its run, in that order: a start
 * that has claimed its run but not yet created it leaves no run to stop, and the
 * tombstone is what makes the run it goes on to create take no step. `false`
 * when a claim could not be fenced, which the caller reports as an attempt run
 * still owed.
 */
export async function stopRuns(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<boolean> {
  const { goalRunId } = record;
  const fenced = await fenceOvertakenAttempts(dependencies, record);
  for (const runId of runsToStop(record)) {
    const stopped = await dependencies.cancelRun(runId).catch((error: unknown) => ({
      status: 'failed' as const,
      error,
    }));
    if (stopped.status === 'failed') {
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${runId}" for goal "${goalRunId}": ${describe(stopped.error)}`,
        cause: stopped.error,
      });
    }
  }
  return fenced;
}

/**
 * One fresh read of every condition `cancel()` answers for. A record that the
 * fresh read cannot return (deleted, or no longer decodable, since the caller
 * read it) is answered as exactly that, never papered over with the caller's
 * older copy: `canceled` is only ever said of a record read back as `canceled`.
 */
export async function readBack(
  dependencies: GoalControlDependencies,
  goalRunId: string,
  attemptRunIds: readonly string[],
  scoped: boolean,
  /** Whether every attempt claim the cancellation owed a tombstone was fenced; `false` is an attempt run still owed. */
  fenced = true,
): Promise<BureauGoalCancelOutcome> {
  const { store, getEngine } = dependencies;
  const goal = await store.get(goalRunId);
  if (goal === undefined) {
    return !scoped && (await store.isUnreadable(goalRunId))
      ? { outcome: 'record-unreadable' }
      : { outcome: 'not-found' };
  }
  const awaiting = await unfinishedAfterCancellation(
    getEngine(),
    goalRunId,
    attemptRunIds,
    goal.status === 'canceled',
    dependencies.diagnose,
  );
  if (!fenced && !awaiting.includes('attempt-run')) awaiting.push('attempt-run');
  return awaiting.length === 0
    ? { outcome: 'canceled', goal }
    : { outcome: 'cancellation-pending', goal, awaiting };
}

/** What a read finds unfinished: the record, the controller, its finalizer, and each attempt run. */
export async function unfinishedAfterCancellation(
  engine: GoalEngine | undefined,
  goalRunId: string,
  attemptRunIds: readonly string[],
  recordCanceled: boolean,
  diagnose?: GoalControlDependencies['diagnose'],
): Promise<BureauGoalCancellationWait[]> {
  const awaiting: BureauGoalCancellationWait[] = [];
  if (!recordCanceled) awaiting.push('goal-record');
  // Without an engine nothing about the workflow can be read, so nothing can be
  // acknowledged: the answer is never `canceled` on the strength of the record.
  if (engine === undefined) return [...awaiting, 'durable-engine'];

  // A read that fails is unfinished, never settled, and it is named: a record
  // that is corrupt cannot be retried into health, and an answer that only says
  // `attempt-run` reads as one still in progress.
  const unreadable =
    (what: string) =>
    (error: unknown): undefined => {
      diagnose?.({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not read ${what} of goal "${goalRunId}" to confirm its cancellation: ${describe(error)}`,
        cause: error,
      });
      return undefined;
    };
  const controller = await engine
    .get(goalWorkflowId(goalRunId))
    .catch(unreadable('the controller'));
  if (
    controller === undefined ||
    (controller !== null && !TERMINAL_CONTROLLER_STATUSES.has(controller.status))
  ) {
    awaiting.push('controller');
  }
  const finalizer = await engine
    .getFinalizerStatus(goalWorkflowId(goalRunId))
    .catch(unreadable("the controller's finalizer"));
  if (finalizer !== undefined && finalizer !== null && finalizer.status === 'failed') {
    // Dead-lettered: the engine has stopped retrying, so asking again will not
    // settle it. Say so, rather than letting it read as one still in progress.
    awaiting.push('finalizer-failed');
    diagnose?.({
      level: 'error',
      scope: 'goals',
      message: `[bureau] The finalizer of goal "${goalRunId}" failed after ${finalizer.attempts} attempt${finalizer.attempts === 1 ? '' : 's'} and will not be retried: ${finalizer.error}`,
    });
  } else if (finalizer === undefined || (finalizer !== null && finalizer.status !== 'succeeded')) {
    awaiting.push('finalizer');
  }
  const runs = await Promise.all(
    attemptRunIds.map((runId) => engine.get(runId).catch(unreadable(`run "${runId}"`))),
  );
  if (
    runs.some(
      (run) => run === undefined || (run !== null && !TERMINAL_CONTROLLER_STATUSES.has(run.status)),
    )
  ) {
    awaiting.push('attempt-run');
  }
  return awaiting;
}
