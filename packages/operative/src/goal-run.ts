/**
 * `startGoal` — the in-memory GoalRun controller (COR-634, COR-638's decision
 * record).
 *
 * A goal run owns one goal across attempts. Each attempt wraps exactly one
 * `SessionHandle.run()` (one `AgentRun`) and exactly one validator execution;
 * the attempt is the retry unit. The controller never edits an inner run's
 * stop conditions, and per-attempt budgets are the session's own
 * `RunOptionsBase.maximumSteps`/`maximumTokens` — `GoalBudget` adds only the
 * attempt count and the aggregate ceilings, so there is no second per-attempt
 * budget system.
 *
 * Two rules keep the state machine honest:
 *
 * - `transition()` is the only writer of `status`, and it rejects every edge
 *   out of a terminal status.
 * - Every `await` is wrapped in `untilTerminal()` and re-checked with
 *   `isTerminal()` when it resumes, so a validator or inner run that
 *   settles after the goal left `evaluating`, was canceled, or ended is
 *   ignored rather than applied a second time.
 *
 * Out of scope: durable Bureau resources, recovery, retry-now/pause/resume,
 * and `goal.recovered`.
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type { RuntimeServices, Subscription, TypedEventTarget } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

import type { AgentRun } from './agent-run';
import type { ValidatorError } from './errors';
import {
  GoalAttemptStartedEvent,
  GoalAttemptValidatedEvent,
  GoalCanceledEvent,
  GoalCancellationRequestedEvent,
  GoalExhaustedEvent,
  GoalFailedEvent,
  GoalFeedbackRecordedEvent,
  GoalRetryingEvent,
  GoalStartedEvent,
  GoalSucceededEvent,
  type OperativeEventMap,
} from './events';
import {
  applyConversationPolicy,
  type ConversationPolicy,
} from './fresh-attempt/conversation-policy';
import {
  ATTEMPT_RUN_FAILURE_DETAIL,
  canTransitionGoalRun,
  decideAttemptRunFailure,
  decideDeterminismRequirement,
  decideDurationElapsed,
  decideOutcome,
  decideRetryOrExhaust,
  decideRunFinish,
  freezeValidatorOutcome,
  goalAttemptInput,
  isDurationBoundElapsed,
  isFailedReason,
  OPERATOR_ABORT_DETAIL,
  stripValidatorErrorCause,
  TERMINAL_STATUS_BY_REASON,
  TERMINAL_STATUSES,
  validateGoalConfiguration,
  type GoalBudget,
  type GoalConversationPolicy,
  type GoalDecision,
  type GoalDecisionContext,
  type GoalIdentity,
  type GoalRetryableReason,
  type GoalRetryPolicy,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type GoalRunTerminalStatus,
  type GoalUsage,
  type ValidatorIdentity,
  type ValidatorOutcome,
  type ValidatorResult,
} from './goal-decision';
import { executeValidator } from './goal-validator-execution';
import type { SessionHandle } from './session/session-handle-types';
import type { CleanupAcknowledgement, ClosedOptions, FinishReason, RunResult } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidatorInput {
  readonly goalRunId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  /** The inner run's terminal result; its `finishReason` is always `'stop-condition'`. */
  readonly result: RunResult;
  /** Prior attempts, oldest first. A snapshot: mutating it affects nothing. */
  readonly history: readonly GoalAttemptRecord[];
}

export interface Validator {
  readonly identity: ValidatorIdentity;
  /**
   * `'stochastic'` marks a judge that cannot supply deterministic evidence.
   * Paired with `StartGoalOptions.requireDeterministicValidation` it ends the
   * goal as `failed`/`unsupported-validation` instead of accepting the judge.
   */
  readonly determinism?: 'deterministic' | 'stochastic' | undefined;
  validate(
    input: ValidatorInput,
    signal: AbortSignal,
  ): Promise<ValidatorOutcome> | ValidatorOutcome;
}

export interface GoalAttemptRecord {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly runId: string | undefined;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly completedAt: string | undefined;
  readonly finishReason: FinishReason | undefined;
  /** Structured evidence lives here, never in an event. */
  readonly validation: ValidatorResult | undefined;
  readonly feedback: string | undefined;
  readonly usage: {
    readonly steps: number;
    readonly tokens: number;
    readonly costUsd: number | undefined;
  };
  readonly status: 'running' | 'evaluating' | 'passed' | 'failed' | 'aborted';
}

/** Targets one attempt. Omitted, the current attempt. */
export interface GoalAttemptTarget {
  readonly attemptId?: string | undefined;
}

export interface StartGoalOptions {
  readonly identity: GoalIdentity;
  /**
   * The baseline session. Attempt 0 runs on it; later attempts follow
   * `conversationPolicy`. A `SessionHandle`, not a bare `RunnableAgent`: all
   * three conversation policies are session operations.
   */
  readonly session: SessionHandle;
  readonly prompt: string;
  /** Required by `fresh-from-artifact`, which seeds a brand-new conversation. */
  readonly instructions?: string | undefined;
  readonly validator: Validator;
  readonly budget: GoalBudget;
  readonly conversationPolicy: GoalConversationPolicy;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  /** A validator running longer than this ends as an `error` of kind `'timeout'`. */
  readonly validatorTimeoutMs?: number | undefined;
  readonly requireDeterministicValidation?: boolean | undefined;
  /** The requesting principal, recorded on `goal.cancellation-requested`. */
  readonly principal?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly runtime?: RuntimeServices | undefined;
  readonly goalRunId?: string | undefined;
  readonly emitter?: TypedEventTarget<OperativeEventMap> | undefined;
}

export type GoalRunEvent =
  | GoalStartedEvent
  | GoalAttemptStartedEvent
  | GoalAttemptValidatedEvent
  | GoalFeedbackRecordedEvent
  | GoalRetryingEvent
  | GoalSucceededEvent
  | GoalExhaustedEvent
  | GoalFailedEvent
  | GoalCancellationRequestedEvent
  | GoalCanceledEvent;

export interface GoalRunResult {
  readonly goalRunId: string;
  readonly status: GoalRunTerminalStatus;
  readonly terminalReason: GoalRunTerminalReason;
  readonly attempts: readonly GoalAttemptRecord[];
  readonly usage: GoalUsage;
  /** Set when a validator `error` (or an `unavailable` outside the retry policy) ended the goal. */
  readonly validatorError?: ValidatorError | undefined;
  /** Human-readable context for a failure that has no `ValidatorError`. */
  readonly failureDetail?: string | undefined;
}

/** The handle `startGoal` returns. Deliberately not `PromiseLike`. */
export interface GoalRun extends AsyncIterable<GoalRunEvent> {
  readonly goalRunId: string;
  readonly identity: GoalIdentity;
  readonly kind: 'goal-run';
  status(): GoalRunStatus;
  currentAttempt(): GoalAttemptRecord | undefined;
  /** A synchronous snapshot; mutating it never affects the goal. */
  attempts(): readonly GoalAttemptRecord[];
  usage(): GoalUsage;
  budget(): GoalBudget;
  terminalReason(): GoalRunTerminalReason | undefined;
  lastFeedback(): string | undefined;
  /** Cached: every call returns the same promise, which resolves at the terminal state. */
  result(): Promise<GoalRunResult>;
  /** Cancels the whole goal. Idempotent. */
  abort(reason?: string): void;
  /**
   * Aborts one attempt only. Idempotent; a finished or unknown attempt is a
   * no-op. The goal itself is not canceled. This is an explicit operator
   * action, so it needs no `retryOn` entry: the attempt is recorded
   * `'aborted'` (mid-run its inner run finishes `'aborted'` and is never
   * validated; mid-validation the validator is canceled through its signal),
   * and the goal then starts the next attempt, announced by `goal.retrying`
   * once that attempt opens, while attempt and aggregate-budget headroom remain.
   * Calling it from a `goal.retrying` listener with that event's `nextAttemptId`
   * aborts the attempt that just opened before its run starts, and the same
   * retry-or-exhaust rule applies. An id that was never announced is a no-op. With none left it ends
   * `exhausted` as `attempt-limit-reached` or `aggregate-budget-exceeded`.
   * An inner run that ends `'aborted'` for any other reason is still an
   * attempt failure (`failed`/`attempt-run-failed`).
   */
  abortAttempt(target?: GoalAttemptTarget, reason?: string): void;
  /**
   * Resolves once the goal is terminal and every inner run has acknowledged
   * its own cleanup. Never rejects. `options.signal` bounds only this call.
   */
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
  /** Aborts a non-terminal goal; a no-op on a terminal one. */
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// Buffered multi-consumer event feed
// ---------------------------------------------------------------------------

/**
 * Every iterator reads from the start of the log, so a late consumer still
 * sees every event, and the stream ends once the goal is terminal.
 */
function createEventFeed<T extends object>() {
  const log: T[] = [];
  let waiters: (() => void)[] = [];
  let ended = false;

  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resume of pending) resume();
  };

  return {
    push(event: T): void {
      log.push(event);
      wake();
    },
    end(): void {
      ended = true;
      wake();
    },
    iterate(): AsyncIterator<T> {
      let index = 0;
      let returned = false;
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            if (returned) return { value: undefined, done: true };
            const value = log[index];
            if (value !== undefined) {
              index += 1;
              return { value, done: false };
            }
            if (ended) return { value: undefined, done: true };
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        },
        async return(): Promise<IteratorResult<T>> {
          returned = true;
          // Wake every pending next() so it observes `returned` and resolves done.
          wake();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// startGoal
// ---------------------------------------------------------------------------

interface MutableAttempt {
  attemptId: string;
  attemptIndex: number;
  runId: string | undefined;
  sessionId: string;
  startedAt: string;
  completedAt: string | undefined;
  finishReason: FinishReason | undefined;
  validation: ValidatorResult | undefined;
  feedback: string | undefined;
  usage: { steps: number; tokens: number; costUsd: number | undefined };
  status: GoalAttemptRecord['status'];
}

interface FinishExtras {
  readonly validatorError?: ValidatorError | undefined;
  readonly failureDetail?: string | undefined;
  /** Runs after the status change and before the terminal event. */
  readonly beforeTerminalEvent?: (() => void) | undefined;
}

type AttemptDirective =
  { readonly next: 'retry'; readonly feedback: string | undefined } | { readonly next: 'stop' };

/** The prior attempt a retried attempt follows; `goal.retrying` names it once the next attempt opens. */
interface RetryOf {
  readonly priorAttemptId: string;
}

const STOP: AttemptDirective = { next: 'stop' };

function snapshotAttempt(attempt: MutableAttempt): GoalAttemptRecord {
  return { ...attempt, usage: { ...attempt.usage } };
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

export function startGoal(options: StartGoalOptions): GoalRun {
  validateGoalConfiguration(options);

  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const goalRunId = options.goalRunId ?? runtime.identifiers.next('goal-run');
  const { validator, retryPolicy } = options;
  // Snapshot the validated configuration once: the caller keeps its own objects,
  // and mutating them after start must not bypass validation.
  const budget: GoalBudget = Object.freeze({ ...options.budget });
  const conversationPolicy: ConversationPolicy = Object.freeze({
    ...options.conversationPolicy,
  });
  const { prompt, instructions } = options;
  const retryOn = new Set<GoalRetryableReason>(retryPolicy?.retryOn ?? []);
  const startedMonotonic = runtime.monotonic.now();

  const goalController = new AbortController();
  const goalSignal = options.signal
    ? AbortSignal.any([options.signal, goalController.signal])
    : goalController.signal;

  const feed = createEventFeed<GoalRunEvent>();
  const attempts: MutableAttempt[] = [];
  const runs: AgentRun[] = [];
  let status: GoalRunStatus = 'pending';
  let terminalReason: GoalRunTerminalReason | undefined;
  let frozenDurationMs: number | undefined;
  let totalSteps = 0;
  let totalTokens = 0;
  let totalCostUsd: number | undefined;
  let attemptController: AbortController | undefined;
  /** Attempts the operator ended with `abortAttempt()`, as opposed to any other abort. */
  const operatorAborted = new Set<string>();
  let liveRun: AgentRun | undefined;
  let durationTimer: unknown;
  /**
   * `goal.attempt.started` waits for the wrapped run's real id, which the
   * session reserves asynchronously. Whatever else is emitted first flushes it,
   * so it can never be overtaken by a later event of the same attempt.
   */
  let pendingAttemptStart: (() => void) | undefined;
  let settleResult: (result: GoalRunResult) => void = () => {};
  let markTerminated: () => void = () => {};

  const resultPromise = new Promise<GoalRunResult>((resolve) => {
    settleResult = resolve;
  });
  const signalPromise = new Promise<void>((resolve) => {
    markTerminated = resolve;
  });

  const isTerminal = (): boolean => TERMINAL_STATUSES.includes(status);

  const flushAttemptStart = (): void => {
    const announce = pendingAttemptStart;
    pendingAttemptStart = undefined;
    announce?.();
  };

  const emit = (event: GoalRunEvent): void => {
    flushAttemptStart();
    feed.push(event);
    options.emitter?.dispatchEvent(event);
  };

  const durationMs = (): number => frozenDurationMs ?? runtime.monotonic.now() - startedMonotonic;

  const usage = (): GoalUsage => ({
    attempts: attempts.length,
    steps: totalSteps,
    tokens: totalTokens,
    costUsd: totalCostUsd,
    durationMs: durationMs(),
  });

  const transition = (next: GoalRunStatus): void => {
    if (!canTransitionGoalRun(status, next)) {
      throw new Error(`GoalRun ${goalRunId}: illegal transition ${status} -> ${next}.`);
    }
    status = next;
  };

  const currentAttempt = (): MutableAttempt | undefined => attempts.at(-1);

  const closeCurrentAttemptAsAborted = (): void => {
    const attempt = currentAttempt();
    if (attempt && (attempt.status === 'running' || attempt.status === 'evaluating')) {
      attempt.status = 'aborted';
      attempt.completedAt = runtime.clock.nowISO();
    }
  };

  const finishGoal = (
    next: GoalRunTerminalStatus,
    reason: GoalRunTerminalReason,
    extras: FinishExtras = {},
  ): void => {
    transition(next);
    terminalReason = reason;
    frozenDurationMs = runtime.monotonic.now() - startedMonotonic;
    if (durationTimer !== undefined) runtime.timers.clearTimeout(durationTimer);
    durationTimer = undefined;
    goalSignal.removeEventListener('abort', onGoalAbort);
    extras.beforeTerminalEvent?.();
    emit(terminalEvent(next, reason, extras));
    feed.end();
    markTerminated();
    settleResult({
      goalRunId,
      status: next,
      terminalReason: reason,
      attempts: attempts.map(snapshotAttempt),
      usage: usage(),
      ...(extras.validatorError === undefined ? {} : { validatorError: extras.validatorError }),
      ...(extras.failureDetail === undefined ? {} : { failureDetail: extras.failureDetail }),
    });
  };

  const terminalEvent = (
    next: GoalRunTerminalStatus,
    reason: GoalRunTerminalReason,
    extras: FinishExtras,
  ): GoalRunEvent => {
    if (next === 'succeeded') return new GoalSucceededEvent({ goalRunId });
    if (next === 'canceled') return new GoalCanceledEvent({ goalRunId });
    if (next === 'exhausted') {
      return new GoalExhaustedEvent({
        goalRunId,
        terminalReason: reason === 'attempt-limit-reached' ? reason : 'aggregate-budget-exceeded',
      });
    }
    if (!isFailedReason(reason)) {
      throw new Error(`Goal terminal reason '${reason}' does not belong to status 'failed'.`);
    }
    return new GoalFailedEvent({
      goalRunId,
      terminalReason: reason,
      // The live event never carries `cause`: it can hold arbitrary validator
      // internals, which the contract keeps off live and telemetry events.
      validatorError:
        extras.validatorError === undefined
          ? undefined
          : stripValidatorErrorCause(extras.validatorError),
    });
  };

  function onGoalAbort(): void {
    if (isTerminal()) return;
    emit(new GoalCancellationRequestedEvent({ goalRunId, principal: options.principal }));
    attemptController?.abort(goalSignal.reason);
    liveRun?.abort(typeof goalSignal.reason === 'string' ? goalSignal.reason : undefined);
    closeCurrentAttemptAsAborted();
    finishGoal('canceled', 'goal-canceled');
  }

  // ---- budget accounting ---------------------------------------------------

  const decisionContext = (): GoalDecisionContext => ({
    budget,
    retryOn: [...retryOn],
    usage: usage(),
  });

  const accountUsage = (attempt: MutableAttempt, result: RunResult): void => {
    attempt.usage = {
      steps: result.steps.length,
      tokens: result.usage.total,
      costUsd: result.costEstimate?.totalCost,
    };
    totalSteps += attempt.usage.steps;
    totalTokens += attempt.usage.tokens;
    if (attempt.usage.costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + attempt.usage.costUsd;
    }
  };

  // ---- async helpers that never outlive the goal ---------------------------

  /** Resolves with `undefined` as soon as the goal is terminal, so no await outlives it. */
  const untilTerminal = async <T>(work: Promise<T>): Promise<{ value: T } | undefined> =>
    Promise.race([work.then((value) => ({ value })), signalPromise.then(() => undefined)]);

  const runValidator = (
    input: ValidatorInput,
    signal: AbortSignal,
  ): Promise<{ outcome: ValidatorOutcome; startedAt: string; completedAt: string }> =>
    executeValidator(validator, input, signal, {
      timeoutMs: options.validatorTimeoutMs,
      runtime,
    });

  // ---- one attempt -----------------------------------------------------------

  const attemptInput = (index: number, feedback: string | undefined): string =>
    goalAttemptInput(conversationPolicy.kind, prompt, index, feedback);

  /**
   * Maps a pure decision onto the state machine. `goal.retrying` is not
   * emitted here: it waits for the next attempt to open (see openAttempt), so
   * an exhausted or failed goal never announces a retry.
   */
  const applyDecision = (decision: GoalDecision, announce: () => void): AttemptDirective => {
    switch (decision.kind) {
      case 'retry':
        transition('retrying');
        announce();
        return { next: 'retry', feedback: decision.feedback };
      case 'succeed':
      case 'cancel':
        finishGoal(TERMINAL_STATUS_BY_REASON[decision.reason], decision.reason, {
          beforeTerminalEvent: announce,
        });
        return STOP;
      case 'exhaust':
        finishGoal('exhausted', decision.reason, {
          beforeTerminalEvent: announce,
          failureDetail: decision.failureDetail,
        });
        return STOP;
      case 'fail':
        finishGoal('failed', decision.reason, {
          beforeTerminalEvent: announce,
          validatorError: decision.validatorError,
          failureDetail: decision.failureDetail,
        });
        return STOP;
    }
  };

  const failAttempt = (
    attempt: MutableAttempt,
    detail: string,
    attemptStatus: 'failed' | 'aborted' = 'failed',
  ): AttemptDirective => {
    attempt.status = attemptStatus;
    attempt.completedAt = runtime.clock.nowISO();
    return applyDecision(decideAttemptRunFailure(detail), () => {});
  };

  const openAttempt = (
    index: number,
    attemptId: string,
    session: SessionHandle,
    retryOf: RetryOf | undefined,
  ): MutableAttempt => {
    const attempt: MutableAttempt = {
      attemptId,
      attemptIndex: index,
      runId: undefined,
      sessionId: session.id,
      startedAt: runtime.clock.nowISO(),
      completedAt: undefined,
      finishReason: undefined,
      validation: undefined,
      feedback: undefined,
      usage: { steps: 0, tokens: 0, costUsd: undefined },
      status: 'running',
    };
    attempts.push(attempt);
    attemptController = new AbortController();
    liveRun = undefined;
    transition('running');
    // `goal.retrying` is announced only here, once the next attempt's session is
    // resolved and the attempt is open, so it is always followed by that
    // attempt's `goal.attempt.started`. A goal that ends while the session is
    // still resolving (duration bound, rejected conversation policy) therefore
    // never announces a retry it did not make. The one exception is an explicit
    // goal abort from a `goal.retrying` listener, which ends the goal as
    // `canceled` before `goal.attempt.started` is flushed.
    if (retryOf !== undefined) {
      emit(
        new GoalRetryingEvent({
          goalRunId,
          priorAttemptId: retryOf.priorAttemptId,
          nextAttemptId: attemptId,
        }),
      );
      if (isTerminal()) return attempt;
    }
    pendingAttemptStart = () =>
      emit(
        new GoalAttemptStartedEvent({
          goalRunId,
          attemptId,
          attemptIndex: index,
          runId: attempt.runId,
        }),
      );
    return attempt;
  };

  /** Adopts the wrapped run's real id the moment its session has reserved one. */
  const adoptRunId = (attempt: MutableAttempt, observedId: string): void => {
    if (attempt.runId !== undefined || !observedId.startsWith(`${attempt.sessionId}:`)) return;
    attempt.runId = observedId;
    flushAttemptStart();
  };

  /**
   * A fork or fresh session that lands after the goal is terminal is simply
   * ignored: `SessionHandle` has no dispose or delete verb, the new handle owns
   * no live run, and `closed()` accounts for runs only.
   */
  const resolveSession = async (index: number): Promise<SessionHandle | undefined> => {
    if (index === 0 || conversationPolicy.kind === 'continue') return options.session;
    const applied = await untilTerminal(
      applyConversationPolicy(options.session, {
        policy: conversationPolicy,
        instructions: instructions ?? '',
      }),
    );
    return applied?.value;
  };

  const applyOutcome = (
    attempt: MutableAttempt,
    outcome: ValidatorOutcome,
    inputFeedback: string | undefined,
  ): AttemptDirective => {
    const announce = (): void => {
      emit(
        new GoalAttemptValidatedEvent({
          goalRunId,
          attemptId: attempt.attemptId,
          validatorIdentity: { ...validator.identity },
          outcomeKind: outcome.kind,
        }),
      );
      if (outcome.kind === 'fail') {
        emit(
          new GoalFeedbackRecordedEvent({
            goalRunId,
            attemptId: attempt.attemptId,
            feedbackDigest: sha256HexSync(outcome.feedback),
          }),
        );
      }
    };
    return applyDecision(
      decideOutcome(decisionContext(), {
        outcome,
        inputFeedback,
        operatorAborted: operatorAborted.has(attempt.attemptId),
      }),
      announce,
    );
  };

  const attemptStatusFor = (outcome: ValidatorOutcome): GoalAttemptRecord['status'] => {
    if (outcome.kind === 'pass') return 'passed';
    return outcome.kind === 'canceled' ? 'aborted' : 'failed';
  };

  const evaluate = async (
    attempt: MutableAttempt,
    result: RunResult,
    inputFeedback: string | undefined,
  ): Promise<AttemptDirective> => {
    transition('evaluating');
    attempt.status = 'evaluating';
    const signal = AbortSignal.any([goalSignal, (attemptController ?? goalController).signal]);
    const settled = await untilTerminal(
      runValidator(
        {
          goalRunId,
          attemptId: attempt.attemptId,
          attemptIndex: attempt.attemptIndex,
          result,
          history: attempts.slice(0, -1).map(snapshotAttempt),
        },
        signal,
      ),
    );
    // Late settlement: the goal ended, or left `evaluating`, while the
    // validator ran. Nothing is applied. `settled` is only defined when the
    // validator won the race, so the status check is a defensive guard for the
    // goal ending between the validator settling and this continuation running.
    if (settled === undefined || status !== 'evaluating') return STOP;
    // The bound is enforced after validation too, not only by its timer: a
    // verdict that arrives once the duration is spent is not applied.
    if (isDurationBoundElapsed(budget, durationMs())) {
      closeCurrentAttemptAsAborted();
      return applyDecision(decideDurationElapsed(), () => {});
    }
    const { startedAt, completedAt } = settled.value;
    // An abortAttempt() that landed after the validator settled but before this
    // continuation ran still wins: the attempt was operator-aborted.
    const outcome: ValidatorOutcome = operatorAborted.has(attempt.attemptId)
      ? { kind: 'canceled' }
      : settled.value.outcome;
    attempt.validation = Object.freeze({
      identity: Object.freeze({ ...validator.identity }),
      startedAt,
      completedAt,
      outcome: freezeValidatorOutcome(outcome),
    });
    attempt.feedback = outcome.kind === 'fail' ? outcome.feedback : undefined;
    attempt.status = attemptStatusFor(outcome);
    attempt.completedAt = completedAt;
    return applyOutcome(attempt, outcome, inputFeedback);
  };

  const executeAttempt = async (
    index: number,
    attemptId: string,
    feedback: string | undefined,
    retryOf: RetryOf | undefined,
  ): Promise<AttemptDirective> => {
    let session: SessionHandle | undefined;
    try {
      session = await resolveSession(index);
    } catch (thrown) {
      return applyDecision(
        decideAttemptRunFailure(ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy(messageOf(thrown))),
        () => {},
      );
    }
    if (session === undefined || isTerminal()) return STOP;

    const attempt = openAttempt(index, attemptId, session, retryOf);
    if (isTerminal()) return STOP;
    if (operatorAborted.has(attemptId)) {
      // abortAttempt() named this attempt from a `goal.retrying` listener, before
      // its run existed: skip running it and apply the same retry-or-exhaust rule.
      attempt.status = 'aborted';
      attempt.completedAt = runtime.clock.nowISO();
      return applyDecision(
        decideRetryOrExhaust(decisionContext(), feedback, OPERATOR_ABORT_DETAIL),
        () => {},
      );
    }
    let agentRun: AgentRun;
    try {
      agentRun = session.run(attemptInput(index, feedback));
    } catch (thrown) {
      return failAttempt(attempt, ATTEMPT_RUN_FAILURE_DETAIL.runStart(messageOf(thrown)));
    }
    runs.push(agentRun);
    liveRun = agentRun;

    let settled: { value: RunResult } | undefined;
    let snapshotSubscription: Subscription | undefined;
    try {
      snapshotSubscription = agentRun.subscribeSnapshot((snapshot) =>
        adoptRunId(attempt, snapshot.id),
      );
      settled = await untilTerminal(agentRun.result());
    } catch (thrown) {
      if (isTerminal()) return STOP;
      return failAttempt(attempt, ATTEMPT_RUN_FAILURE_DETAIL.runRejected(messageOf(thrown)));
    } finally {
      snapshotSubscription?.unsubscribe();
    }
    adoptRunId(attempt, agentRun.snapshot().id);
    if (settled === undefined || isTerminal()) return STOP;

    const { value: result } = settled;
    attempt.finishReason = result.finishReason;
    accountUsage(attempt, result);
    const finish = decideRunFinish(decisionContext(), {
      finishReason: result.finishReason,
      operatorAborted: operatorAborted.has(attemptId),
      costEstimateReported: result.costEstimate !== undefined,
      feedback,
    });
    if (finish.kind === 'decision') {
      attempt.status = finish.attemptStatus;
      attempt.completedAt = runtime.clock.nowISO();
      return applyDecision(finish.decision, () => {});
    }
    return evaluate(attempt, result, feedback);
  };

  const runGoal = async (): Promise<void> => {
    let feedback: string | undefined;
    let retryOf: RetryOf | undefined;
    for (let index = 0; !isTerminal(); index += 1) {
      const attemptId = runtime.identifiers.next('goal-attempt');
      const directive = await executeAttempt(index, attemptId, feedback, retryOf);
      if (directive.next === 'stop') return;
      feedback = directive.feedback;
      retryOf = { priorAttemptId: attemptId };
    }
  };

  // ---- controls ----------------------------------------------------------------

  const abortAttempt = (target?: GoalAttemptTarget, reason?: string): void => {
    const attempt = currentAttempt();
    if (attempt === undefined || isTerminal()) return;
    if (target?.attemptId !== undefined && target.attemptId !== attempt.attemptId) return;
    if (attempt.status !== 'running' && attempt.status !== 'evaluating') return;
    if (attemptController === undefined || attemptController.signal.aborted) return;
    operatorAborted.add(attempt.attemptId);
    attemptController.abort(reason);
    liveRun?.abort(reason);
  };

  let closedPromise: Promise<CleanupAcknowledgement> | undefined;
  const settleAllRuns = async (): Promise<CleanupAcknowledgement> => {
    await resultPromise;
    const acknowledgements = await Promise.all(
      runs.map(async (run): Promise<CleanupAcknowledgement> => {
        try {
          return await run.closed();
        } catch (error) {
          return { status: 'failed', error };
        }
      }),
    );
    const worst = acknowledgements.find(
      (acknowledgement) =>
        acknowledgement.status === 'failed' || acknowledgement.status === 'unresolved',
    );
    if (worst) return worst;
    return acknowledgements.some((acknowledgement) => acknowledgement.status === 'completed')
      ? { status: 'completed' }
      : { status: 'not-required' };
  };

  const closed = (closedOptions?: ClosedOptions): Promise<CleanupAcknowledgement> => {
    closedPromise ??= settleAllRuns();
    const shared = closedPromise;
    const signal = closedOptions?.signal;
    if (signal === undefined) return shared;
    return new Promise<CleanupAcknowledgement>((resolve) => {
      const onAbort = (): void => resolve({ status: 'unresolved', reason: 'timed-out' });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void shared.then((acknowledgement) => {
        signal.removeEventListener('abort', onAbort);
        resolve(acknowledgement);
        return undefined;
      });
    });
  };

  const handle: GoalRun = {
    goalRunId,
    identity: { ...options.identity },
    kind: 'goal-run',
    status: () => status,
    currentAttempt: () => {
      const attempt = currentAttempt();
      return attempt === undefined ? undefined : snapshotAttempt(attempt);
    },
    attempts: () => attempts.map(snapshotAttempt),
    usage,
    budget: () => ({ ...budget }),
    terminalReason: () => terminalReason,
    lastFeedback: () => attempts.findLast((attempt) => attempt.feedback !== undefined)?.feedback,
    result: () => resultPromise,
    abort(reason?: string): void {
      goalController.abort(reason);
    },
    abortAttempt,
    closed,
    [Symbol.dispose](): void {
      if (!isTerminal()) goalController.abort('disposed');
    },
    [Symbol.asyncIterator]: () => feed.iterate(),
  };

  // ---- start -----------------------------------------------------------------------

  // `goal.started` is the first event on every path, including a goal canceled
  // or rejected before any attempt runs: the goal exists from this point. It is
  // emitted at construction, while `status()` is still 'pending'; the contract
  // table's pending -> running edge is realized by `goal.attempt.started`.
  emit(new GoalStartedEvent({ goalRunId, goalIdentity: { ...options.identity } }));

  if (goalSignal.aborted) {
    onGoalAbort();
    return handle;
  }
  goalSignal.addEventListener('abort', onGoalAbort, { once: true });

  const unsupported = decideDeterminismRequirement(
    options.requireDeterministicValidation,
    validator.determinism,
  );
  if (unsupported !== undefined) {
    applyDecision(unsupported, () => {});
    return handle;
  }

  if (budget.maximumTotalDurationMs !== undefined) {
    durationTimer = runtime.timers.setTimeout(() => {
      if (isTerminal()) return;
      attemptController?.abort('aggregate-budget-exceeded');
      liveRun?.abort('aggregate-budget-exceeded');
      closeCurrentAttemptAsAborted();
      applyDecision(decideDurationElapsed(), () => {});
    }, budget.maximumTotalDurationMs);
  }

  void runGoal().catch((thrown: unknown) => {
    if (isTerminal()) return;
    applyDecision(
      decideAttemptRunFailure(ATTEMPT_RUN_FAILURE_DETAIL.controller(messageOf(thrown))),
      () => {},
    );
  });

  return handle;
}
