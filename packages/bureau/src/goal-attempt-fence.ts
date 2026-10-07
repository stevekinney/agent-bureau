/**
 * COR-851 — the self-fence of a goal attempt's run.
 *
 * There is no transaction across the attempt's catalog claim (a write to the
 * recovery record's key) and the engine's start of its workflow, and Weft's
 * `engine.start` takes no precondition on stored bytes. So no check made from
 * outside can close the window between the two: a start that has claimed its run
 * but not yet created it can be overtaken by a cancellation, an exhausted
 * duration, or a close, and then create a run nothing is looking for. What can be
 * done is to make the run refuse to work once it exists. This file is that
 * refusal, and it is the backstop that sits after the non-atomic start and before
 * any side effect.
 *
 * The fence is a `prepareStep` hook registered in the run's own hook tier, ahead
 * of every other `prepareStep` handler, so it runs before the generate call and
 * the tool calls of every step, on a fresh start and on a recovered run alike. It
 * lets the step proceed only when both of these are read now:
 *
 * - the goal's record exists, is neither terminal nor marked for cancellation, and
 *   has not spent its aggregate duration (`maximumTotalDurationMs`);
 * - the attempt's catalog claim is the goal's own for this attempt and is not
 *   tombstoned. A goal that ends, closes, or is canceled tombstones the claims of
 *   the attempts it may have overtaken (see `goal-cancellation.ts`), so a start
 *   that lost the race finds the tombstone here.
 *
 * What runs before `prepareStep` in a step is operative's own preparation: the
 * step-started event, context compaction, and the `selectTools` and
 * `selectToolChoice` hooks. Compaction is the one that can reach a model, so the
 * same verdict also gates it, through a `beforeCompaction` handler that cancels
 * the compaction of a step the goal does not allow. Operative consults the
 * same handler, registered as `beforeBackgroundCompaction`, before a step requests a
 * background compaction, so a refused step starts neither. One reading serves a step's compaction and `prepareStep`
 * handlers. A background candidate that the fence allowed and that is already
 * running when the goal ends is withdrawn only by the run's own abort signal, and
 * it publishes through the conversation's compare-and-swap. The event and the selection
 * hooks make no model or tool call, and the fence that follows them stops the
 * step before anything the step would do.
 *
 * It fails closed, and it does not mistake a fault for a verdict. A read that
 * fails is tried again, backing off on the runtime's clock (a fault that lasts a
 * moment is ridden out, and a step abort ends the wait). Only if the goal and its
 * claim still cannot be read after the last try does the step not run, because a
 * step that ran on an unknown is exactly what the fence exists to prevent. A fence
 * that stops a run ends it with a tripwire error, which no `onError` hook can retry
 * or skip, so the run takes zero agent steps and finishes cleanly. The controller
 * reads that finish as the attempt's run failing, so a fault that outlasts every
 * try (the backoffs add up to a few seconds, and the goal's own store is down for
 * that long too) costs the goal that attempt.
 *
 * Acknowledged-only runs. The fence also lets a step proceed only once the goal's
 * record shows this attempt opened as running (the controller's open-attempt
 * commit, after `startAttempt` returns). Until then the run waits, polling at the
 * short acknowledgement cadence, for at most the start activity's own bound
 * (tries times per-try timeout, or what remains of the goal's duration if less).
 * The budget is measured from when the run's first reading began, on the runtime's
 * monotonic clock, and is spent by that clock or by the delays waited, whichever
 * is greater. The run is created inside the start activity, so its first reading
 * falls after the activity began and the budget outlasts the activity by at
 * least the gap between the two; the commit follows the activity's return.
 * The budget is a bound, not a promise. A controller that commits later than it
 * (a start that took both tries to their timeouts, a recovery or bounded restart
 * that revives the controller after the budget) leaves the run stopped with zero
 * steps, and the controller then reads that as the attempt's run failing: the
 * attempt is lost, and no step was taken without an acknowledgement. That cost is
 * accepted, because the alternative, a run that steps unacknowledged or waits
 * without bound, is the very hazard this fence exists to remove.
 *
 * What the fence gates is the agent step: the generate call, the tool calls, and
 * the compaction that can reach a model. What it does not gate is anything that
 * runs before a run's first step and calls neither: the run's started event and
 * its `onRunStart` hooks, which fire in the starting process before the engine
 * creates the run (a late run's start already ran them, in the try that created
 * it); the workflow's first `saveConversation` activity, which writes the
 * conversation and the prompt to the store; the step's own events; and the
 * `onRunError` and `onRunComplete` hooks of a run the fence stops. Bureau's
 * invariant tier, which holds the fence, is composed ahead of every other tier,
 * so no `prepareStep` or compaction handler of a lower tier runs before it, and
 * the memory recall and the guardrail scans, which are `prepareStep` handlers,
 * run after it. A hook that notifies or writes externally from `onRunStart` is
 * therefore outside the fence, and the residual of this paragraph is its named
 * bound.
 *
 * Residual: a run whose start was overtaken still exists, as a workflow that
 * ended after zero steps under the attempt's deterministic id. `cleanUpGoal`
 * prunes every attempt id up to `maximumAttempts` at close and at the boot sweep,
 * so that record is retired with the rest of the goal's history.
 */

import type { HookRegistry, RuntimeServices, RuntimeTimeoutHandle } from '@lostgradient/lifecycle';
import {
  GuardrailTripwireError,
  isDeadlineElapsed,
  type OperativeHookMap,
  remainingMilliseconds,
  START_ATTEMPT_MAXIMUM_TRIES,
  START_ATTEMPT_TIMEOUT_MS,
} from '@lostgradient/operative';

import { isGoalOwnedRunRecord, type RunRecordReader } from './goal-ownership';
import { isTerminalGoalStatus } from './goal-state';
import type { GoalStore } from './goal-store';

/** The attempt a run was started for. */
export interface GoalAttemptTarget {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly runId: string;
}

/**
 * What the fence concluded from its reads of the goal and the attempt's claim.
 * `await-open` is a goal that is alive and a claim that is its own, with the
 * attempt not yet acknowledged as running; `budgetMs` is how long the run may wait
 * for the controller's open-attempt commit.
 */
export type GoalAttemptVerdict =
  | { readonly status: 'run' }
  | { readonly status: 'refuse' }
  | { readonly status: 'await-open'; readonly budgetMs: number };

export interface GoalAttemptFence {
  /**
   * Whether the attempt's run may take a step, from reads made now. A rejection
   * is a read that could not be made, which the hook treats as a refusal after its
   * tries.
   */
  mayRun(target: GoalAttemptTarget): Promise<GoalAttemptVerdict>;
}

const RUN: GoalAttemptVerdict = { status: 'run' };
const REFUSE: GoalAttemptVerdict = { status: 'refuse' };

/**
 * The longest a run waits for its attempt to be acknowledged: the start activity's
 * own bound, never invented separately from it.
 */
export const GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS =
  START_ATTEMPT_MAXIMUM_TRIES * START_ATTEMPT_TIMEOUT_MS;

/**
 * How long a run waits before each further read of a goal whose attempt is not
 * yet open, on the runtime's clock; the last delay repeats until the budget is
 * spent. It is deliberately not the read-error backoff: the controller's
 * open-attempt commit follows the start's return within milliseconds, and a
 * backoff that grows toward seconds would delay the first agent step of nearly
 * every attempt. Each poll is a read of the goal and of the run's claim, so the
 * cadence settles at one every half second.
 */
export const GOAL_ATTEMPT_ACKNOWLEDGEMENT_POLL_DELAYS_MS: readonly number[] = [50, 100, 250, 500];

/** The id the fence's hook is registered under. */
export const GOAL_ATTEMPT_FENCE_HOOK_ID = 'bureau:goal-attempt-fence';

/**
 * How long the fence waits before each further read of a goal or claim it could
 * not read, on the runtime's clock. The first read is immediate, so the number of
 * reads is one more than the number of delays.
 */
export const GOAL_ATTEMPT_FENCE_READ_DELAYS_MS: readonly number[] = [100, 500, 2_000, 5_000];

/** How many times the fence reads before it treats the answer as unknown and refuses. */
export const GOAL_ATTEMPT_FENCE_READ_TRIES = GOAL_ATTEMPT_FENCE_READ_DELAYS_MS.length + 1;

/**
 * The fence over the goal store and the recovery records. `undefined` for the
 * record is a goal that cannot be read as well as one that does not exist, and
 * neither may run.
 */
export function createGoalAttemptFence(dependencies: {
  readonly store: Pick<GoalStore, 'get'>;
  readonly readRunRecord: RunRecordReader;
  /** The clock the goal's aggregate duration is measured on, which bounds the acknowledgement wait. */
  readonly clock: { now(): number };
}): GoalAttemptFence {
  return {
    async mayRun(target) {
      const record = await dependencies.store.get(target.goalRunId);
      if (
        record === undefined ||
        record.cancellation !== undefined ||
        isTerminalGoalStatus(record.status)
      ) {
        return REFUSE;
      }
      // The aggregate duration, on the clock the controller measures it on: a goal
      // recovered after its deadline resumes this run beside a controller that is
      // about to commit it exhausted, and the run must take no further step first.
      if (isDeadlineElapsed(record, dependencies.clock.now())) return REFUSE;
      const load = await dependencies.readRunRecord(target.runId);
      if (load.status === 'read-error') throw load.error;
      if (load.status !== 'found') return REFUSE;
      const claimed = load.record.goalAttempt;
      // The goal's own claim for this attempt, by the one test every ownership
      // decision shares: the marker reproduces the run's id, and the agent and
      // principal are the goal's own, read from the goal's record above and not
      // from the claim.
      if (!(
        claimed?.goalRunId === target.goalRunId &&
        claimed.attemptIndex === target.attemptIndex &&
        claimed.tombstonedAt === undefined &&
        isGoalOwnedRunRecord(load.record, target.runId, {
          agentName: record.objective.agentName,
          principal: record.principal,
          maximumAttempts: record.bounds.maximumAttempts,
        })
      )) {
        return REFUSE;
      }
      // Acknowledged-only runs: the record must show this attempt open.
      const attempt = record.attempts[target.attemptIndex];
      if (attempt === undefined) {
        // The attempt the controller is about to open is the next one; a run for
        // any later index has no attempt to wait for.
        if (record.attempts.length !== target.attemptIndex) return REFUSE;
        const remaining = remainingMilliseconds(record, dependencies.clock.now());
        const budgetMs = Math.min(
          GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS,
          remaining ?? GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS,
        );
        return budgetMs > 0 ? { status: 'await-open', budgetMs } : REFUSE;
      }
      const open =
        attempt.runId === target.runId &&
        attempt.status === 'running' &&
        target.attemptIndex === record.attempts.length - 1 &&
        record.active?.kind === 'attempt' &&
        record.active.attemptId === attempt.attemptId &&
        record.active.runId === target.runId;
      return open ? RUN : REFUSE;
    },
  };
}

/** A fence the bureau has not bound yet: it refuses, so a step that beats the binding fails closed. */
export class GoalAttemptFenceUnboundError extends Error {
  constructor() {
    super('A goal attempt ran a step before Bureau bound the goal attempt fence.');
    this.name = 'GoalAttemptFenceUnboundError';
  }
}

export interface GoalAttemptFenceHost {
  /** The fence to hand to the runtime composition and the dispatcher, which exist before the goal store does. */
  readonly fence: GoalAttemptFence;
  bind(fence: GoalAttemptFence): void;
}

/**
 * The runtime composition and the catalog dispatcher are built before the goal
 * store and the recovery-record reader the fence needs, so they hold a fence that
 * forwards to whatever is bound later, and refuses until then.
 */
export function createGoalAttemptFenceHost(): GoalAttemptFenceHost {
  let bound: GoalAttemptFence | undefined;
  return {
    fence: {
      mayRun: (target) =>
        Promise.resolve().then(() => {
          if (bound === undefined) throw new GoalAttemptFenceUnboundError();
          return bound.mayRun(target);
        }),
    },
    bind(fence) {
      bound = fence;
    },
  };
}

const refusal = (target: GoalAttemptTarget, detail: string): GuardrailTripwireError =>
  new GuardrailTripwireError(
    `Attempt ${target.attemptIndex} of goal "${target.goalRunId}" may not run: ${detail}.`,
    {
      guardrailName: 'goal-attempt-fence',
      category: 'goal-attempt-fence',
      phase: 'input',
      confidence: 1,
      detail,
    },
  );

export interface GoalAttemptFenceRegistration {
  /**
   * The runtime whose timers the backoff between reads waits on; without one the
   * reads are made back to back. Its monotonic clock, when it has one, measures
   * the acknowledgement wait, so that slow reads cannot stretch it past its budget.
   */
  readonly runtime?: Pick<RuntimeServices, 'timers'> & Partial<Pick<RuntimeServices, 'monotonic'>>;
  /** The delay before each further read of a read that failed; defaults to `GOAL_ATTEMPT_FENCE_READ_DELAYS_MS`. */
  readonly delaysMs?: readonly number[];
  /** The delay before each further read while the attempt is not yet open; defaults to `GOAL_ATTEMPT_ACKNOWLEDGEMENT_POLL_DELAYS_MS`. */
  readonly acknowledgementDelaysMs?: readonly number[];
}

/** Waits `delay` milliseconds on the runtime's timers, or until `signal` aborts. */
function waitFor(
  runtime: Pick<RuntimeServices, 'timers'>,
  delay: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // `armed` is what makes reading `handle` safe: an abort that lands, or a timer that
    // fires, before `setTimeout` has returned ends the wait while `handle` has no value yet.
    let armed = false;
    function done(): void {
      if (armed) runtime.timers.clearTimeout(handle);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    // Listen before arming the timer, so an abort that lands as the timer is set
    // (or before it fires) ends the wait instead of being missed.
    signal?.addEventListener('abort', done, { once: true });
    const handle: RuntimeTimeoutHandle = runtime.timers.setTimeout(done, delay);
    armed = true;
    if (signal?.aborted) done();
  });
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/**
 * What the fence concluded from its reads: a verdict, or `undefined` and the fault
 * that kept it from one. `unacknowledged` is a run whose attempt never opened
 * within its budget (or could not be waited for).
 */
interface FenceReading {
  readonly verdict: 'run' | 'refuse' | 'unacknowledged' | undefined;
  readonly cause: unknown;
}

async function readFence(
  fence: GoalAttemptFence,
  target: GoalAttemptTarget,
  registration: GoalAttemptFenceRegistration,
  signal: AbortSignal | undefined,
): Promise<{ readonly verdict: GoalAttemptVerdict | undefined; readonly cause: unknown }> {
  const delays = registration.delaysMs ?? GOAL_ATTEMPT_FENCE_READ_DELAYS_MS;
  let cause: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return { verdict: await fence.mayRun(target), cause };
    } catch (error) {
      cause = error;
    }
    // A step that was aborted has no use for the answer, and is refused below.
    if (signal?.aborted === true) break;
    const delay = delays[attempt];
    if (delay !== undefined && registration.runtime !== undefined) {
      await waitFor(registration.runtime, delay, signal);
      // An abort that ended the wait ends the reading, with no further read.
      if (isAborted(signal)) break;
    }
  }
  return { verdict: undefined, cause };
}

/**
 * Reads the fence until it has a verdict, waiting for the attempt to be
 * acknowledged when the only thing missing is the controller's open-attempt
 * commit. The wait polls on the runtime's clock at the acknowledgement cadence
 * (its last delay repeated), for at most the budget the first `await-open`
 * carried. The budget is spent by whichever is greater, the delays waited or the
 * time the runtime's monotonic clock shows since the first read began, so slow
 * reads cannot stretch it, and a delay of zero cannot spin without spending it. An
 * abort ends it with no further read. A fault in a read keeps `readFence`'s
 * fail-closed retries, and a verdict of `undefined` still means unknown.
 */
async function readSettled(
  fence: GoalAttemptFence,
  target: GoalAttemptTarget,
  registration: GoalAttemptFenceRegistration,
  signal: AbortSignal | undefined,
): Promise<FenceReading> {
  const delays =
    registration.acknowledgementDelaysMs ?? GOAL_ATTEMPT_ACKNOWLEDGEMENT_POLL_DELAYS_MS;
  const monotonic = registration.runtime?.monotonic;
  let waitedMs = 0;
  let budgetMs: number | undefined;
  // Anchored before the first read, so that read's own duration counts against the budget.
  const startedAt = monotonic?.now();
  for (let polls = 0; ; polls += 1) {
    const { verdict, cause } = await readFence(fence, target, registration, signal);
    if (verdict === undefined) return { verdict: undefined, cause };
    if (verdict.status !== 'await-open') return { verdict: verdict.status, cause: undefined };
    budgetMs ??= verdict.budgetMs;
    const elapsedMs = Math.max(
      waitedMs,
      monotonic === undefined || startedAt === undefined ? 0 : monotonic.now() - startedAt,
    );
    // Without a runtime there is no clock to wait on: the run is not acknowledged.
    if (registration.runtime === undefined || isAborted(signal) || elapsedMs >= budgetMs) {
      return { verdict: 'unacknowledged', cause: undefined };
    }
    const delay = Math.min(
      Math.max(delays[Math.min(polls, delays.length - 1)] ?? budgetMs - elapsedMs, 1),
      budgetMs - elapsedMs,
    );
    await waitFor(registration.runtime, delay, signal);
    // An abort that ended the wait ends the reading, with no further read.
    if (isAborted(signal)) return { verdict: 'unacknowledged', cause: undefined };
    waitedMs += delay;
  }
}

/**
 * Registers the fence as the first `prepareStep` handler of a run's invariant
 * tier, and as a `beforeCompaction` handler that cancels the compaction of a step
 * it does not allow. The hooks read nothing they can change and write nothing, so
 * replaying them is safe.
 *
 * A step's boundary is decided once. Compaction runs first and the step's
 * `prepareStep` right after it, so the compaction handler leaves its reading for
 * that step in a slot and `prepareStep` takes it, rather than repeating the reads
 * (and the backoff, if the store is down). `prepareStep` always empties the slot, so
 * a later step, or a replay of this one, reads again.
 */
export function registerGoalAttemptFence(
  registry: HookRegistry<OperativeHookMap>,
  fence: GoalAttemptFence,
  target: GoalAttemptTarget,
  registration: GoalAttemptFenceRegistration = {},
): void {
  let compactionReading:
    { readonly step: number; readonly reading: Promise<FenceReading> } | undefined;
  registry.on(
    'prepareStep',
    async (context) => {
      const shared = compactionReading;
      compactionReading = undefined;
      const { verdict, cause } = await (shared?.step === context.step
        ? shared.reading
        : readSettled(fence, target, registration, context.signal));
      if (verdict === 'run') return;
      if (verdict === 'unacknowledged') {
        throw refusal(
          target,
          'the goal never acknowledged this attempt as running, and a run takes no step until it has',
        );
      }
      throw verdict === 'refuse'
        ? refusal(
            target,
            'the goal ended, was canceled, or no longer holds this attempt (its claim is tombstoned, or its record shows another attempt or run)',
          )
        : refusal(
            target,
            `the goal and the attempt's claim could not be read (${cause instanceof Error ? cause.message : String(cause)}), and a step is never taken on an unknown`,
          );
    },
    { id: GOAL_ATTEMPT_FENCE_HOOK_ID, replay: 'safe' },
  );
  const decideCompaction = async (context: {
    readonly step: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<false | undefined> => {
    // Compaction, synchronous or background, may call a model, and it runs before
    // `prepareStep`. A step the fence allows is left to the other handlers
    // (`undefined` is no verdict); one it does not allow is not compacted, and the
    // `prepareStep` handler above then refuses it. The same reading serves that
    // handler.
    const reading = readSettled(fence, target, registration, context.signal);
    compactionReading = { step: context.step, reading };
    const { verdict } = await reading;
    return verdict === 'run' ? undefined : false;
  };
  registry.on('beforeCompaction', decideCompaction, {
    id: `${GOAL_ATTEMPT_FENCE_HOOK_ID}:compaction`,
    replay: 'safe',
  });
  registry.on('beforeBackgroundCompaction', decideCompaction, {
    id: `${GOAL_ATTEMPT_FENCE_HOOK_ID}:background-compaction`,
    replay: 'safe',
  });
}
