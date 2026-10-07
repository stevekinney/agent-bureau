/**
 * COR-851 — the durable `goalRun` workflow: the single-owner controller of one
 * goal.
 *
 * The in-memory controller (`startGoal`) keeps its state in closures. This one
 * keeps none: the durable `GoalState` record is the state, every transition is
 * committed to it through an idempotent activity, and every decision is made by
 * the same pure functions `startGoal` uses (`goal-decision.ts`). The workflow
 * holds only plain data, takes every effect through {@link GoalWorkflowPorts}
 * (no closure is serialized), and is registered without `services`, so Weft
 * never writes a services marker for it and never consults the services
 * resolver when it recovers.
 *
 * ## One loop, driven by the record
 *
 * Each iteration begins with a fresh read of the record (a "decision point")
 * and does one segment of work chosen by what it reads, never by a counter held
 * in a local. A brand-new instance, an instance replaying after a crash, and
 * the adoption of a rejected or stale commit are therefore the same code path:
 * they all read the record and continue from whatever it says. `record.cancellation`
 * is authoritative; the `cancel` signal only wakes the controller sooner.
 *
 * ## Slot sequence
 *
 * Weft keys durable operations by position, so a replay must issue the same
 * operations in the same order. Every branch below is a pure function of
 * results already recorded earlier in the same history (the record read, the
 * race winner, a commit result), so replaying a history re-takes the branch it
 * took the first time and no slot is ever conditional on anything unrecorded.
 * The rejected-commit path adds no slot of its own: a commit that answers
 * `stale` or `rejected` simply ends the iteration, and the next one reads the
 * authoritative record.
 *
 * Every iteration:
 *
 * ```text
 * L   loadGoalState                       the decision point
 *     terminal                -> return the result (no further slot)
 *     record missing/corrupt  -> return 'record-unavailable'
 * ```
 *
 * then, by what `L` read, the first matching row:
 *
 * ```text
 * cancellation marker set                 (any non-terminal status)
 *   A   abortAttempt                       no-op when no run exists
 *   C   commitTransition  -> canceled      the in-flight attempt is closed 'aborted' in it
 *
 * aggregate duration elapsed              (any non-terminal status)
 *   A   abortAttempt
 *   C   commitTransition  -> exhausted     aggregate-budget-exceeded
 *
 * pending | retrying
 *   S   startAttempt                       start-or-adopt by the deterministic run id. Awaited to
 *                                          settlement, never raced against the deadline; Weft's own
 *                                          per-try timeout, retry, and (with a duration bound)
 *                                          scheduleToCloseTimeout bound a hung one (see below)
 *       started | adopted -> C commitTransition -> running   attempt N, usage.attempts = N + 1, active = attempt
 *       failed            -> L2 loadGoalState    re-read: the start may have outlasted the bound
 *                              marker set or status moved -> nothing more; the next L handles it
 *                              aggregate duration elapsed -> A abortAttempt, C -> exhausted
 *                              S' commitTransition -> failed (attempt-run-failed) in place of C,
 *                              stamped with the re-read's clock
 *       stood-down        -> nothing more (the port created nothing: the goal was canceled, ended,
 *                            or out of time before the start wrote anything); the next L reads the
 *                            marker or the elapsed bound with a fresh clock and ends the goal
 *
 * running
 *   R   raceKeyed { attempt: waitForSignal('attempt-terminal:N'),
 *                   cancel:  waitForSignal('cancel'),
 *                   deadline: sleep(remaining) }      deadline only when a duration bound is set
 *       cancel | deadline won   -> nothing more; the next L sees the marker or the elapsed bound
 *       attempt won:
 *         L2  loadGoalState               re-read: the marker, the status, and the clock
 *             marker set, status moved, or bound elapsed -> nothing more; the next L handles it
 *         C   commitTransition -> evaluating     the run reached 'stop-condition'
 *         C   commitTransition -> <decision>     any other finish reason skips the validator
 *
 * evaluating
 *   V   runValidator                       at-least-once: a crash here re-runs it; raced against
 *                                          sleep(remaining) when a duration bound is set, and given
 *                                          min(validatorTimeoutMs, remaining) as its own timeout.
 *                                          When the deadline wins nothing more: the next L sees the
 *                                          elapsed bound and ends the goal (A, C -> exhausted)
 *   L2  loadGoalState                      re-read: the marker, the status, and the clock
 *       marker set or status moved -> nothing more; the next L handles it
 *       aggregate duration elapsed while the validator ran (the verdict is not applied):
 *         A   abortAttempt
 *         C   commitTransition -> exhausted     aggregate-budget-exceeded
 *   C   commitTransition -> <decision>     the verdict and the decision, together
 * ```
 *
 * ## Waiting on code the workflow does not own
 *
 * The attempt's own signal and the validator are raced against the aggregate
 * deadline, so a hung one cannot hold a goal past `maximumTotalDurationMs`. With
 * a bound, the race is `raceKeyed({ work, deadline })` (one branch more than the
 * unbounded wait); the choice depends only on the recorded read, so a replay
 * opens the same race. The validator is also told not to outlast the deadline
 * (its timeout is clamped to what remains, and the port's `executeValidator`
 * enforces it), so a validator that honors a timeout is not abandoned running;
 * one that ignores it is, and its verdict is discarded. A validator with an
 * external effect is therefore only as safe to abandon as it is idempotent, which
 * is what declaring determinism promises and nothing else does.
 *
 * The start of an attempt is the exception, and deliberately so. It has a
 * durable side effect (the claim, then the run), so abandoning it at the
 * deadline would leave an outstanding start the controller does not know about:
 * a run that could appear after the goal ended. The controller therefore waits
 * for the start to settle, and its answer is always known (`started`,
 * `adopted`, `stood-down`, or `failed`). After that, enforcing the deadline is a
 * plain abort of a run the controller knows exists (`A`, then `C -> exhausted`).
 * A start that has not settled is bounded by Weft instead (`startAttemptOptions`):
 * a per-try timeout (not shortened to the deadline, so a slow start is waited
 * for), one retry, and with a duration bound a `scheduleToCloseTimeout` of the
 * remaining duration plus one more try. Retry is only a top-level `ctx.run`
 * feature, which is why the start is no longer inside a race, where an
 * activity never retries. A timed-out try keeps
 * running in the background, and the retry adopts the run it created (the
 * ownership check and the deterministic run id) or stands down. The start port
 * re-reads the goal before every write, including the aggregate deadline measured
 * exactly as this controller measures it, and answers `stood-down` rather than
 * claim or start anything for a goal that is over; a run it created that the goal
 * ended over while it started is stopped by the port, including when the cause is the
 * deadline (the controller waits for the starts it issued, but not for a timed-out
 * background try or the host's own recovery start, which only this check bounds). Past the last try the
 * controller fails and Bureau restarts it from the record (a bounded number of
 * times), and the restarted controller ends the goal at its deadline.
 *
 * A try that Weft timed out, even the last one, may still complete later and
 * create its run with no controller left to adopt or stop it. That run is
 * harmless by one invariant, owned by Bureau's attempt fence
 * (`goal-attempt-fence.ts`): acknowledged-only runs. A goal attempt's run takes
 * no agent step until the goal's record shows this attempt opened as running,
 * which is the `commit -> running` slot above, made after `startAttempt`
 * returns. The slot order here is unchanged and the run's wait cannot hold the
 * controller up: the commit follows the start's return and waits on nothing the
 * run does. In the window between the engine's start and the commit the run
 * polls the record for at most `START_ATTEMPT_MAXIMUM_TRIES` tries of
 * `START_ATTEMPT_TIMEOUT_MS` (or the goal's remaining duration if less); a
 * controller that crashed after the start returned replays the memoized result
 * and commits, a controller that Bureau's bounded restart revives within the budget
 * adopts the late run and commits `running`, which acknowledges it, and a controller
 * that failed for good never commits, so the late run takes zero steps. What it leaves is a zero-step workflow record under the
 * attempt's deterministic id, which `cleanUpGoal` prunes.
 *
 * What remains is the crash an at-least-once activity always has, between the
 * engine's start committing the run and the port finishing its stand-down check,
 * and its background twin: a timed-out try that was still running when the goal
 * ended. In either the process can die before the run is stopped, leaving a run
 * the terminal goal never names, so the host's recovery stops whatever run an
 * `exhausted`, `canceled`, or start-failed (`failed`, `attempt-run-failed`) goal's ending left (`attemptToStop`'s target and the
 * last recorded attempt's), at every boot and `recover()` and in `close()`, until
 * the goal is closed and its cleanup recorded. A crash on this side of the
 * commit needs no sweep: the replayed start adopts the run, and the next
 * decision point aborts it.
 *
 * Replay: the start now sits at a top-level slot with retry options, where it
 * used to be one branch of a race. That is a different slot order from the one
 * the previous revision recorded, which is acceptable only because the workflow
 * is pre-release and no history of it exists in the wild.
 *
 * The decision is committed once even though the validator may run twice: the
 * transition carries `decisionId = <attemptId>:decision`, the store accepts the
 * first and answers `duplicate`, `stale`, or `decision-already-recorded` to any
 * other, and the controller then adopts whatever the next read says.
 *
 * ## Cancellation and the deadline
 *
 * A cooperative cancellation is the `abortAttempt` and `commitTransition` pair
 * above. If the owner escalates to `engine.cancel`, the generator dies
 * mid-flight and nothing here can commit the terminal transition, so the host
 * completes it: it reads the engine's `cancelled` status together with the
 * record's cancellation marker and commits `canceled` through the store.
 *
 * The workflow also declares a definition-level finalizer, `finalizeGoal`, so
 * the run an attempt left behind is stopped even when the generator never got
 * to. At every decision point, right after the record read, the controller
 * stages `ctx.setFinalizerState` with the run a cancellation must stop (the
 * same target `abortAttempt` names: the attempt in flight, or the next
 * attempt's deterministic id for an orphan a crashed start left). Staging is
 * not a durable slot: it is a pure function of the recorded read, it is
 * committed with the next checkpoint, and a recovered workflow re-stages it
 * from the same history, so the slot sequence above is unchanged. After a
 * `cancelled` or `timed-out` terminal Weft drives the finalizer with the last
 * staged value, retrying and re-driving it across a crash, and it calls the
 * same idempotent `abortAttempt` port. A replaying controller re-stages each
 * recorded iteration's older target until it reaches the live frontier, so
 * `finalizeGoal` also re-reads the record when it runs (it is never replayed)
 * and stops the in-flight run named there; a hard cancel that lands mid-replay
 * still ends the right run. A workflow that ends `completed` or
 * `failed` owes no finalizer, and one that never reached a decision point
 * staged nothing, so `getFinalizerStatus` answers `null` for both: nothing owed.
 *
 * The deadline timer is a race branch: Weft anchors it to the
 * checkpoint time on resume, so a restart re-arms the same absolute deadline
 * rather than a fresh one, and the elapsed bound is checked again from a fresh
 * clock reading at every decision point regardless.
 *
 * ## Concurrency
 *
 * Weft's `workflow-lease` ownership fences this workflow to one engine. A
 * deposed controller that still issues a write is harmless: each commit request
 * is a deterministic function of the record it read, so it either answers
 * `duplicate` (the same transition is already current) or `stale` (the record
 * moved on), and a controller that receives either re-reads.
 */

import type { ActivityCallOptions, WorkflowContext } from '@lostgradient/weft';
import { workflow } from '@lostgradient/weft';

import {
  decideAttemptRunFailure,
  decideCancellation,
  decideDurationElapsed,
  decideOutcome,
  decideRunFinish,
  type GoalDecision,
} from '../goal-decision';
import { createGoalWorkflowActivities } from './goal-workflow-activities';
import {
  GOAL_CANCEL_SIGNAL,
  GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
  GOAL_WORKFLOW_TYPE,
  type GoalAttemptTerminalSignal,
  goalAttemptTerminalSignalName,
  GoalControllerError,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowCommit,
  type GoalWorkflowInput,
  type GoalWorkflowPorts,
  type GoalWorkflowResult,
  type GoalWorkflowTransition,
  type GoalWorkflowView,
} from './goal-workflow-ports';
import {
  abortRequestFor,
  buildEvaluationStarted,
  buildGoalForcedFinish,
  buildOpenAttempt,
  buildRunFinishDecision,
  buildStartFailure,
  buildValidationDecision,
  currentAttemptOf,
  decisionContextFor,
  goalInputFeedbackFor,
  isDeadlineElapsed,
  isTerminalStatus,
  remainingMilliseconds,
} from './goal-workflow-transitions';

type GoalContext = WorkflowContext;

/** What one iteration did: the commit it made, or `undefined` when it only waited. */
type Segment = Generator<unknown, GoalWorkflowCommit | undefined, unknown>;

/**
 * Consecutive iterations whose commit was refused (`stale`, or a rejection the
 * next read resolves) before the controller gives up. A healthy goal never
 * refuses twice in a row: the refusal is what makes the next read authoritative.
 */
const MAXIMUM_CONSECUTIVE_REFUSALS = 5;

/**
 * Consecutive iterations that only waited (a wake with no marker behind it, an
 * attempt signal for a record that moved on, a deadline the record's clock does
 * not agree has elapsed) before the controller gives up. Bounds how much history
 * a controller whose two clocks disagree could write.
 */
const MAXIMUM_CONSECUTIVE_IDLE_WAKES = 25;

/** Rejections the next decision point resolves by reading the record. */
const ADOPTABLE_REJECTIONS: readonly string[] = [
  'terminal',
  'cancellation-requested',
  'decision-already-recorded',
];

/**
 * How long one try of the attempt's start may take before Weft stops waiting for
 * it and tries again. Starting an attempt is a handful of local store reads and
 * writes plus the engine's own start, so a minute is generous; what it must not
 * be is unbounded, because a hung start would hold the controller forever.
 *
 * It is deliberately not shortened to what remains of the goal's duration. A
 * try cut off at the deadline is an abandoned start, which is the very thing
 * this timeout exists to avoid for a start that is merely slow: a start still
 * in flight at the deadline is waited for, and only one that outlasts this
 * constant is given up on. The price is that a hung start can hold a bounded
 * goal past its deadline by up to one try.
 */
export const START_ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Tries a hung or failing start is given, with no backoff between them: the
 * start is idempotent, a wait would only slow the failure of a fault that does
 * not clear (Weft's timer resolution makes even a short backoff cost about half
 * a second per failure), and the time since the last try is already the
 * try's own timeout. One retry is enough for a transient fault and keeps a permanent one from
 * delaying the controller's failure (and Bureau's bounded restarts) by much. A
 * timed-out try keeps running in the background (Weft cannot preempt it), and
 * the next one adopts the run it created or stands down: the start is
 * idempotent by the attempt's deterministic run id. Past the last try the
 * controller fails and Bureau's bounded restart takes over.
 */
export const START_ATTEMPT_MAXIMUM_TRIES = 2;
const START_ATTEMPT_INITIAL_BACKOFF_MS = 0;
export const START_ATTEMPT_MAXIMUM_BACKOFF_MS = 0;

export interface GoalWorkflowOptions {
  /** Overrides {@link START_ATTEMPT_TIMEOUT_MS}; tests use it to give a hung start a short fuse. */
  readonly startAttemptTimeoutMs?: number | undefined;
}

/**
 * The Weft options for the attempt's start, a pure function of the remaining
 * duration the controller just read, so a replay passes the same ones.
 *
 * With a duration bound, `scheduleToCloseTimeout` spans every try:
 * the remaining duration, plus one more try of slack. The
 * slack is deliberate. The budget is checked where a retry would be scheduled,
 * so a budget equal to the remaining duration would refuse the very retry that
 * reaches the start port's deadline check and stands down; with the slack that
 * retry is admitted after a hung try times out, answers `stood-down`, and the
 * goal ends at its deadline instead of the controller failing. Without a bound
 * there is nothing to span, and the number of tries is the only limit.
 */
export function startAttemptOptions(
  remainingMs: number | undefined,
  timeoutMs: number = START_ATTEMPT_TIMEOUT_MS,
): ActivityCallOptions {
  const retry = {
    maxAttempts: START_ATTEMPT_MAXIMUM_TRIES,
    initialBackoff: START_ATTEMPT_INITIAL_BACKOFF_MS,
    backoffMultiplier: 2,
    maxBackoff: START_ATTEMPT_MAXIMUM_BACKOFF_MS,
  };
  if (remainingMs === undefined) return { timeout: timeoutMs, retry };
  return {
    timeout: timeoutMs,
    retry,
    scheduleToCloseTimeout: Math.ceil(remainingMs) + timeoutMs + START_ATTEMPT_MAXIMUM_BACKOFF_MS,
  };
}

function terminalResult(view: GoalWorkflowView): GoalWorkflowResult {
  if (view.terminalReason === undefined) {
    throw new GoalControllerError(
      `Goal "${view.goalRunId}" is ${view.status} with no terminal reason.`,
    );
  }
  return {
    schemaVersion: GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
    outcome: 'terminal',
    goalRunId: view.goalRunId,
    status: view.status as Extract<GoalWorkflowResult, { outcome: 'terminal' }>['status'],
    terminalReason: view.terminalReason,
    ...(view.failureDetail === undefined ? {} : { failureDetail: view.failureDetail }),
    transitionSeq: view.transitionSeq,
  };
}

const recordUnavailable = (goalRunId: string): GoalWorkflowResult => ({
  schemaVersion: GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
  outcome: 'record-unavailable',
  goalRunId,
});

function isRefusal(commit: GoalWorkflowCommit): boolean {
  return (
    commit.status === 'stale' ||
    (commit.status === 'rejected' && ADOPTABLE_REJECTIONS.includes(commit.reason))
  );
}

/**
 * Builds the durable `goalRun` workflow over the given ports. The ports are
 * captured once, like `createRunWorkflow`'s checkpoint store, so no per-run
 * registry or `services` is needed.
 */
export function createGoalWorkflow(ports: GoalWorkflowPorts, options: GoalWorkflowOptions = {}) {
  const activities = createGoalWorkflowActivities(ports);
  const { identifiers } = ports;

  const runToStop = (view: GoalWorkflowView): GoalWorkflowAbortRequest =>
    abortRequestFor(view, identifiers);

  function* commit(
    ctx: GoalContext,
    request: GoalWorkflowTransition,
  ): Generator<unknown, GoalWorkflowCommit, unknown> {
    return yield* ctx.run(activities.commitTransition, request);
  }

  function* finishForced(
    ctx: GoalContext,
    view: GoalWorkflowView,
    nowMs: number,
    decision: GoalDecision,
  ): Segment {
    yield* ctx.run(activities.abortAttempt, runToStop(view));
    return yield* commit(ctx, buildGoalForcedFinish(view, identifiers, nowMs, decision));
  }

  /**
   * Runs one activity that calls out to code the workflow does not own, and
   * gives up on it when the aggregate duration elapses first. With no duration
   * bound the activity is simply awaited. The branch taken is a pure function
   * of the recorded read (`view`, `nowMs`), so a replay opens the same race.
   *
   * `elapsed` means the deadline won: nothing was learned about the activity,
   * and the caller returns so the next decision point reads the elapsed bound
   * and ends the goal. The abandoned activity is never relied on again; its
   * effects are the idempotent kind each one documents.
   */
  function* beforeDeadline<TResult>(
    ctx: GoalContext,
    view: GoalWorkflowView,
    nowMs: number,
    operation: () => Generator<unknown, TResult, unknown>,
  ): Generator<
    unknown,
    { readonly elapsed: false; readonly value: TResult } | { readonly elapsed: true },
    unknown
  > {
    const remaining = remainingMilliseconds(view, nowMs);
    if (remaining === undefined) return { elapsed: false, value: yield* operation() };
    const winner = yield* ctx.raceKeyed({
      work: operation(),
      deadline: ctx.sleep(Math.ceil(remaining)),
    });
    return winner.key === 'work' ? { elapsed: false, value: winner.value } : { elapsed: true };
  }

  function* openAttempt(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attemptIndex = view.attempts.length;
    // Never past the bound, whatever the record says. A decision that retries has
    // headroom and the store refuses a `retrying` record without it, so this is
    // reached only by a record that slipped past both; the same exhaustion the
    // decision table would have reached is committed instead of an extra attempt.
    if (attemptIndex >= view.bounds.maximumAttempts) {
      return yield* finishForced(ctx, view, nowMs, {
        kind: 'exhaust',
        reason: 'attempt-limit-reached',
      });
    }
    const feedback = goalInputFeedbackFor(view.attempts, attemptIndex);
    const request = {
      goalRunId: view.goalRunId,
      attemptIndex,
      attemptId: identifiers.attemptId(view.goalRunId, attemptIndex),
      runId: identifiers.attemptRunId(view.goalRunId, attemptIndex),
      ...(feedback === undefined ? {} : { feedback }),
    };
    // Never raced against the deadline: an abandoned start leaves a run the
    // controller does not know about. Weft bounds a hung one instead.
    const started = yield* ctx.run(
      activities.startAttempt,
      request,
      startAttemptOptions(remainingMilliseconds(view, nowMs), options.startAttemptTimeoutMs),
    );
    // Nothing was created: the goal was canceled, ended, or out of time before
    // the start wrote anything. The next decision point reads which.
    if (started.status === 'stood-down') return undefined;
    if (started.status === 'failed') {
      // The start can take as long as Weft's per-try timeout and its retries, so
      // `nowMs` is the time before it. The verdict is committed with the time
      // after it, read through the same recorded slot as every other re-read, and
      // a goal whose duration ran out meanwhile ends as exhausted, as it would at
      // any other decision point.
      const reread = yield* ctx.run(activities.loadGoalState, { goalRunId: view.goalRunId });
      const fresh = reread.view;
      if (
        fresh === undefined ||
        fresh.cancellation !== undefined ||
        fresh.status !== view.status ||
        fresh.transitionSeq !== view.transitionSeq
      ) {
        return undefined;
      }
      if (isDeadlineElapsed(fresh, reread.nowMs)) {
        return yield* finishForced(ctx, fresh, reread.nowMs, decideDurationElapsed());
      }
      const decision = decideAttemptRunFailure(started.detail);
      return yield* commit(ctx, buildStartFailure(fresh, identifiers, reread.nowMs, decision));
    }
    return yield* commit(
      ctx,
      buildOpenAttempt(view, identifiers, nowMs, { attemptIndex, sessionId: started.sessionId }),
    );
  }

  function* awaitAttempt(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attempt = currentAttemptOf(view);
    if (attempt === undefined || attempt.status !== 'running') {
      throw new GoalControllerError(`Goal "${view.goalRunId}" is running with no running attempt.`);
    }
    const signalName = goalAttemptTerminalSignalName(attempt.attemptIndex);
    const remaining = remainingMilliseconds(view, nowMs);
    const winner =
      remaining === undefined
        ? yield* ctx.raceKeyed({
            attempt: ctx.waitForSignal<GoalAttemptTerminalSignal>(signalName),
            cancel: ctx.waitForSignal<unknown>(GOAL_CANCEL_SIGNAL),
          })
        : yield* ctx.raceKeyed({
            attempt: ctx.waitForSignal<GoalAttemptTerminalSignal>(signalName),
            cancel: ctx.waitForSignal<unknown>(GOAL_CANCEL_SIGNAL),
            deadline: ctx.sleep(Math.ceil(remaining)),
          });
    // The signal is an optimisation. Whichever of the marker or the elapsed
    // bound woke the controller, the next decision point reads it from the
    // record and the clock; there is nothing to commit from the wake itself.
    if (winner.key !== 'attempt') return undefined;
    const finished = winner.value;

    const reread = yield* ctx.run(activities.loadGoalState, { goalRunId: view.goalRunId });
    const fresh = reread.view;
    if (
      fresh === undefined ||
      fresh.cancellation !== undefined ||
      fresh.status !== 'running' ||
      fresh.transitionSeq !== view.transitionSeq ||
      isDeadlineElapsed(fresh, reread.nowMs)
    ) {
      return undefined;
    }
    const resolution = decideRunFinish(decisionContextFor(fresh, reread.nowMs), {
      finishReason: finished.finishReason,
      operatorAborted: false,
      costEstimateReported: finished.costUsd !== undefined,
      feedback: goalInputFeedbackFor(fresh.attempts, attempt.attemptIndex),
    });
    if (resolution.kind === 'decision') {
      return yield* commit(
        ctx,
        buildRunFinishDecision(fresh, identifiers, reread.nowMs, attempt, finished, resolution),
      );
    }
    return yield* commit(
      ctx,
      buildEvaluationStarted(fresh, identifiers, reread.nowMs, attempt, finished),
    );
  }

  function* validate(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attempt = currentAttemptOf(view);
    if (attempt === undefined || attempt.status !== 'evaluating') {
      throw new GoalControllerError(
        `Goal "${view.goalRunId}" is evaluating with no evaluating attempt.`,
      );
    }
    // The validator is code the goal's owner supplied. The activity's abort
    // signal reaches it, so cancelling the goal stops one that honors it, but one
    // that ignores it cannot be stopped from outside. It is raced against the
    // deadline, and told not to outlast it.
    const remaining = remainingMilliseconds(view, nowMs);
    const timeoutMs =
      remaining === undefined
        ? view.validatorTimeoutMs
        : Math.min(view.validatorTimeoutMs ?? Infinity, Math.ceil(remaining));
    const validation = yield* beforeDeadline(ctx, view, nowMs, () =>
      ctx.run(activities.runValidator, {
        goalRunId: view.goalRunId,
        attemptId: attempt.attemptId,
        attemptIndex: attempt.attemptIndex,
        validator: view.validator,
        ...(timeoutMs === undefined ? {} : { validatorTimeoutMs: timeoutMs }),
      }),
    );
    if (validation.elapsed) return undefined;
    const result = validation.value;
    const reread = yield* ctx.run(activities.loadGoalState, { goalRunId: view.goalRunId });
    const fresh = reread.view;
    if (
      fresh === undefined ||
      fresh.cancellation !== undefined ||
      fresh.status !== 'evaluating' ||
      fresh.transitionSeq !== view.transitionSeq
    ) {
      return undefined;
    }
    // A verdict that arrives once the duration is spent is not applied: the
    // bound is enforced here as it is at every other decision point.
    if (isDeadlineElapsed(fresh, reread.nowMs)) {
      return yield* finishForced(ctx, fresh, reread.nowMs, decideDurationElapsed());
    }
    const decision = decideOutcome(decisionContextFor(fresh, reread.nowMs), {
      outcome: result.outcome,
      inputFeedback: goalInputFeedbackFor(fresh.attempts, attempt.attemptIndex),
      operatorAborted: false,
    });
    return yield* commit(
      ctx,
      buildValidationDecision(fresh, identifiers, reread.nowMs, attempt, result, decision),
    );
  }

  function* advance(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    if (view.cancellation !== undefined) {
      return yield* finishForced(ctx, view, nowMs, decideCancellation());
    }
    if (isDeadlineElapsed(view, nowMs)) {
      return yield* finishForced(ctx, view, nowMs, decideDurationElapsed());
    }
    switch (view.status) {
      case 'running':
        return yield* awaitAttempt(ctx, view, nowMs);
      case 'evaluating':
        return yield* validate(ctx, view, nowMs);
      default:
        return yield* openAttempt(ctx, view, nowMs);
    }
  }

  return (
    workflow({ name: GOAL_WORKFLOW_TYPE, finalizer: activities.finalizeGoal })
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft durable generator: async work flows through yield*, not a top-level await.
      .execute(async function* (
        ctx,
        input: GoalWorkflowInput,
      ): AsyncGenerator<unknown, GoalWorkflowResult> {
        const { goalRunId } = input;
        let consecutiveRefusals = 0;
        let consecutiveIdleWakes = 0;
        for (;;) {
          const { view, nowMs } = yield* ctx.run(activities.loadGoalState, { goalRunId });
          if (view === undefined) return recordUnavailable(goalRunId);
          if (isTerminalStatus(view.status)) return terminalResult(view);
          // Stage what the finalizer needs, last write wins: the run a hard
          // cancel from here on must stop. It is committed with the next
          // checkpoint, and the replay of a recovered workflow re-stages it
          // from the same recorded read, so it is never a durable slot.
          ctx.setFinalizerState(runToStop(view));

          const committed = yield* advance(ctx, view, nowMs);
          if (committed === undefined) {
            consecutiveIdleWakes += 1;
            if (consecutiveIdleWakes >= MAXIMUM_CONSECUTIVE_IDLE_WAKES) {
              throw new GoalControllerError(
                `Goal "${goalRunId}" woke ${consecutiveIdleWakes} times in a row without anything to do.`,
              );
            }
            continue;
          }
          consecutiveIdleWakes = 0;
          if (committed.status === 'missing' || committed.status === 'corrupt') {
            return recordUnavailable(goalRunId);
          }
          if (committed.status === 'rejected' && !ADOPTABLE_REJECTIONS.includes(committed.reason)) {
            throw new GoalControllerError(
              `Goal "${goalRunId}" transition ${view.transitionSeq + 1} was rejected: ${committed.reason}.`,
            );
          }
          consecutiveRefusals = isRefusal(committed) ? consecutiveRefusals + 1 : 0;
          if (consecutiveRefusals >= MAXIMUM_CONSECUTIVE_REFUSALS) {
            throw new GoalControllerError(
              `Goal "${goalRunId}" transition ${view.transitionSeq + 1} was refused ${consecutiveRefusals} times in a row.`,
            );
          }
        }
      })
  );
}
