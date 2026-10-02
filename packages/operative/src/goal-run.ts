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
import {
  GoalConfigurationError,
  toValidatorError,
  VALIDATOR_ERROR_KINDS,
  type ValidatorError,
} from './errors';
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
  type GoalEventTerminalReason,
  type OperativeEventMap,
} from './events';
import {
  applyConversationPolicy,
  type ConversationPolicy,
} from './fresh-attempt/conversation-policy';
import type { SessionHandle } from './session/session-handle-types';
import type { CleanupAcknowledgement, ClosedOptions, FinishReason, RunResult } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GoalIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * COR-638's aggregate budget. `maximumAttempts` is always required, and at
 * least one of the four aggregate ceilings must accompany it.
 */
export interface GoalBudget {
  readonly maximumAttempts: number;
  readonly maximumTotalDurationMs?: number | undefined;
  readonly maximumTotalSteps?: number | undefined;
  readonly maximumTotalTokens?: number | undefined;
  readonly maximumTotalCostUsd?: number | undefined;
}

export type GoalRetryableReason =
  'validator-fail-retryable' | 'validator-unavailable' | 'validator-canceled';

const GOAL_RETRYABLE_REASONS: readonly GoalRetryableReason[] = [
  'validator-fail-retryable',
  'validator-unavailable',
  'validator-canceled',
];

/** Retries are explicit-only: omit the policy and the goal never retries. */
export interface GoalRetryPolicy {
  readonly retryOn: readonly GoalRetryableReason[];
}

/**
 * The goal's conversation policy. Narrows the shared `ConversationPolicy` so
 * `fork-from-baseline` must name its baseline run: a goal never defaults to
 * "the last attempt".
 */
export type GoalConversationPolicy =
  | Extract<ConversationPolicy, { kind: 'continue' }>
  | Extract<ConversationPolicy, { kind: 'fresh-from-artifact' }>
  | { readonly kind: 'fork-from-baseline'; readonly throughRun: number };

export type GoalRunStatus =
  | 'pending'
  | 'running'
  | 'evaluating'
  | 'retrying'
  | 'succeeded'
  | 'exhausted'
  | 'failed'
  | 'canceled';

export type GoalRunTerminalStatus = Extract<
  GoalRunStatus,
  'succeeded' | 'exhausted' | 'failed' | 'canceled'
>;

/**
 * COR-638's seven reasons plus `attempt-run-failed`: the wrapped `AgentRun`
 * finished with something other than `'stop-condition'` (or its cost could
 * not be accounted), so validation never ran. The contract had no honest
 * reason for that case, and `validator-infrastructure-error` would misstate
 * it.
 */
export type GoalRunTerminalReason = GoalEventTerminalReason;

export interface ValidatorIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * The in-memory record keeps `detail` (and `ValidatorError.cause`) exactly as
 * the validator supplied them, so neither is guaranteed JSON-safe. A durable
 * layer must project both to a JSON-safe form itself before persisting.
 */
export interface ValidatorEvidence {
  readonly source: string;
  readonly detail: unknown;
}

export type ValidatorOutcome =
  | { readonly kind: 'pass'; readonly evidence: readonly ValidatorEvidence[] }
  | {
      readonly kind: 'fail';
      readonly feedback: string;
      readonly evidence: readonly ValidatorEvidence[];
      readonly retryable: boolean;
    }
  | { readonly kind: 'error'; readonly error: ValidatorError }
  | { readonly kind: 'unavailable'; readonly error: ValidatorError; readonly reason: string }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface ValidatorResult {
  readonly identity: ValidatorIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ValidatorOutcome;
}

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

export interface GoalUsage {
  readonly attempts: number;
  readonly steps: number;
  readonly tokens: number;
  /** `undefined` until some attempt reports a `costEstimate`. */
  readonly costUsd: number | undefined;
  readonly durationMs: number;
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
// State machine
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: readonly GoalRunStatus[] = [
  'succeeded',
  'exhausted',
  'failed',
  'canceled',
];

/**
 * Every legal edge. A terminal status has no outgoing edge, and `canceled` is
 * reachable from every non-terminal status.
 *
 * Beyond the contract's main path, two edges cover a goal that ends before any
 * attempt runs: `pending -> failed` (rejected up front as
 * `unsupported-validation`) and `pending -> exhausted` (the aggregate duration
 * bound elapsed before the first attempt opened). `running -> failed` and
 * `running -> exhausted` cover an attempt that cannot reach the validator and
 * a duration bound that elapses mid-attempt. `running -> retrying` covers an
 * operator `abortAttempt()` mid-run, which skips validation and moves on to
 * the next attempt.
 */
export const GOAL_RUN_TRANSITIONS: Readonly<Record<GoalRunStatus, readonly GoalRunStatus[]>> = {
  pending: ['running', 'exhausted', 'failed', 'canceled'],
  running: ['evaluating', 'retrying', 'exhausted', 'failed', 'canceled'],
  evaluating: ['succeeded', 'retrying', 'exhausted', 'failed', 'canceled'],
  retrying: ['running', 'exhausted', 'failed', 'canceled'],
  succeeded: [],
  exhausted: [],
  failed: [],
  canceled: [],
};

export function canTransitionGoalRun(from: GoalRunStatus, to: GoalRunStatus): boolean {
  return GOAL_RUN_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

const AGGREGATE_BOUND_KEYS = [
  'maximumTotalDurationMs',
  'maximumTotalSteps',
  'maximumTotalTokens',
  'maximumTotalCostUsd',
] as const;

function validateBudget(budget: GoalBudget | undefined): void {
  const attempts = budget?.maximumAttempts;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts <= 0) {
    throw new GoalConfigurationError(
      'invalid-maximum-attempts',
      'GoalBudget.maximumAttempts is required and must be a positive integer.',
    );
  }
  let configured = 0;
  for (const key of AGGREGATE_BOUND_KEYS) {
    const value = budget?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new GoalConfigurationError(
        'invalid-aggregate-bound',
        `GoalBudget.${key} must be a positive, finite number.`,
      );
    }
    configured += 1;
  }
  if (configured === 0) {
    throw new GoalConfigurationError(
      'missing-aggregate-bound',
      'GoalBudget requires at least one aggregate bound: maximumTotalDurationMs, maximumTotalSteps, maximumTotalTokens, or maximumTotalCostUsd.',
    );
  }
}

function validateRetryPolicy(policy: GoalRetryPolicy | undefined): void {
  if (policy === undefined) return;
  const retryOn: unknown = policy.retryOn;
  if (
    !Array.isArray(retryOn) ||
    retryOn.length === 0 ||
    !retryOn.every((reason) => GOAL_RETRYABLE_REASONS.some((known) => known === reason))
  ) {
    throw new GoalConfigurationError(
      'invalid-retry-policy',
      `GoalRetryPolicy.retryOn must be a non-empty list drawn from: ${GOAL_RETRYABLE_REASONS.join(', ')}.`,
    );
  }
}

function validateConversationPolicy(options: StartGoalOptions): void {
  const policy: { kind?: unknown; throughRun?: unknown } | undefined = options.conversationPolicy;
  if (policy?.kind === 'continue') return;
  if (policy?.kind === 'fork-from-baseline') {
    const { throughRun } = policy;
    if (typeof throughRun !== 'number' || !Number.isInteger(throughRun) || throughRun < 0) {
      throw new GoalConfigurationError(
        'invalid-baseline',
        'fork-from-baseline requires a goal-declared throughRun: a non-negative integer run index. It never defaults to the last attempt.',
      );
    }
    return;
  }
  if (policy?.kind === 'fresh-from-artifact') {
    if (typeof options.instructions !== 'string' || options.instructions.length === 0) {
      throw new GoalConfigurationError(
        'missing-instructions',
        'fresh-from-artifact seeds a brand-new conversation and requires instructions.',
      );
    }
    return;
  }
  throw new GoalConfigurationError(
    'invalid-conversation-policy',
    'conversationPolicy must be exactly one of continue, fork-from-baseline, or fresh-from-artifact.',
  );
}

function validateGoalConfiguration(options: StartGoalOptions): void {
  const validator: Partial<Validator> | undefined = options.validator;
  if (
    validator === undefined ||
    validator === null ||
    typeof validator.validate !== 'function' ||
    typeof validator.identity?.name !== 'string' ||
    typeof validator.identity.version !== 'string'
  ) {
    throw new GoalConfigurationError(
      'missing-validator',
      'startGoal requires an explicit validator with an identity and a validate() function.',
    );
  }
  validateBudget(options.budget);
  validateRetryPolicy(options.retryPolicy);
  validateConversationPolicy(options);
}

// ---------------------------------------------------------------------------
// Validator output normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEvidenceList(value: unknown): boolean {
  return Array.isArray(value);
}

function isValidatorError(value: unknown): value is ValidatorError {
  return (
    isRecord(value) &&
    VALIDATOR_ERROR_KINDS.some((kind) => kind === value['kind']) &&
    typeof value['code'] === 'string' &&
    typeof value['message'] === 'string'
  );
}

function malformedOutput(detail: string): ValidatorOutcome {
  return {
    kind: 'error',
    error: {
      kind: 'output',
      code: 'MALFORMED_VALIDATOR_OUTPUT',
      message: `The validator returned a malformed outcome: ${detail}.`,
    },
  };
}

/**
 * A malformed return value is a validator infrastructure failure (`error`,
 * kind `'output'`), never a verdict.
 */
function normalizeOutcome(value: unknown): ValidatorOutcome {
  if (!isRecord(value)) return malformedOutput('expected an object');
  switch (value['kind']) {
    case 'pass':
      return isEvidenceList(value['evidence'])
        ? { kind: 'pass', evidence: value['evidence'] as readonly ValidatorEvidence[] }
        : malformedOutput('pass requires an evidence array');
    case 'fail':
      return typeof value['feedback'] === 'string' &&
        isEvidenceList(value['evidence']) &&
        typeof value['retryable'] === 'boolean'
        ? {
            kind: 'fail',
            feedback: value['feedback'],
            evidence: value['evidence'] as readonly ValidatorEvidence[],
            retryable: value['retryable'],
          }
        : malformedOutput('fail requires feedback, an evidence array, and retryable');
    case 'error':
      return isValidatorError(value['error'])
        ? { kind: 'error', error: value['error'] }
        : malformedOutput('error requires a ValidatorError');
    case 'unavailable':
      return isValidatorError(value['error']) && typeof value['reason'] === 'string'
        ? { kind: 'unavailable', error: value['error'], reason: value['reason'] }
        : malformedOutput('unavailable requires a ValidatorError and a reason');
    case 'canceled':
      return { kind: 'canceled' };
    case 'indeterminate':
      return typeof value['reason'] === 'string'
        ? { kind: 'indeterminate', reason: value['reason'] }
        : malformedOutput('indeterminate requires a reason');
    default:
      return malformedOutput('unknown outcome kind');
  }
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

type FailedReason = Extract<
  GoalRunTerminalReason,
  | 'validator-fail-non-retryable'
  | 'validator-infrastructure-error'
  | 'unsupported-validation'
  | 'attempt-run-failed'
>;

/**
 * The terminal status each reason belongs to. Typed as a total `Record`, so a
 * reason added to `GoalEventTerminalReason` fails to compile until it is
 * placed here.
 */
const TERMINAL_STATUS_BY_REASON: Readonly<Record<GoalRunTerminalReason, GoalRunTerminalStatus>> = {
  'validator-passed': 'succeeded',
  'attempt-limit-reached': 'exhausted',
  'aggregate-budget-exceeded': 'exhausted',
  'validator-fail-non-retryable': 'failed',
  'validator-infrastructure-error': 'failed',
  'unsupported-validation': 'failed',
  'attempt-run-failed': 'failed',
  'goal-canceled': 'canceled',
};

const isFailedReason = (reason: GoalRunTerminalReason): reason is FailedReason =>
  TERMINAL_STATUS_BY_REASON[reason] === 'failed';

type AttemptDirective =
  { readonly next: 'retry'; readonly feedback: string | undefined } | { readonly next: 'stop' };

/** The prior attempt a retried attempt follows; `goal.retrying` names it once the next attempt opens. */
interface RetryOf {
  readonly priorAttemptId: string;
}

const STOP: AttemptDirective = { next: 'stop' };

const OPERATOR_ABORT_DETAIL =
  'The attempt was aborted with abortAttempt(), so it was not validated and no further attempt could start.';

/**
 * Detaches a recorded outcome from the validator's own objects and freezes it,
 * so neither the validator nor a caller can rewrite recorded history. `detail`
 * and `cause` values stay as the validator supplied them.
 */
function freezeOutcome(outcome: ValidatorOutcome): ValidatorOutcome {
  const freezeEvidence = (evidence: readonly ValidatorEvidence[]): readonly ValidatorEvidence[] =>
    Object.freeze(evidence.map((item) => Object.freeze({ ...item })));
  const freezeError = (error: ValidatorError): ValidatorError => Object.freeze({ ...error });
  switch (outcome.kind) {
    case 'pass':
    case 'fail':
      return Object.freeze({ ...outcome, evidence: freezeEvidence(outcome.evidence) });
    case 'error':
      return Object.freeze({ ...outcome, error: freezeError(outcome.error) });
    case 'unavailable':
      return Object.freeze({ ...outcome, error: freezeError(outcome.error) });
    default:
      return Object.freeze({ ...outcome });
  }
}

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
          : {
              kind: extras.validatorError.kind,
              code: extras.validatorError.code,
              message: extras.validatorError.message,
            },
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

  const budgetExceeded = (): boolean =>
    (budget.maximumTotalDurationMs !== undefined &&
      durationMs() >= budget.maximumTotalDurationMs) ||
    (budget.maximumTotalSteps !== undefined && totalSteps >= budget.maximumTotalSteps) ||
    (budget.maximumTotalTokens !== undefined && totalTokens >= budget.maximumTotalTokens) ||
    (budget.maximumTotalCostUsd !== undefined &&
      totalCostUsd !== undefined &&
      totalCostUsd >= budget.maximumTotalCostUsd);

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
  ): Promise<{ outcome: ValidatorOutcome; startedAt: string; completedAt: string }> => {
    const startedAt = runtime.clock.nowISO();
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      const validatorController = new AbortController();
      const validatorSignal = AbortSignal.any([signal, validatorController.signal]);

      const finish = (outcome: ValidatorOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) runtime.timers.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({ outcome, startedAt, completedAt: runtime.clock.nowISO() });
      };
      const onAbort = (): void => finish({ kind: 'canceled' });

      if (signal.aborted) {
        finish({ kind: 'canceled' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (options.validatorTimeoutMs !== undefined) {
        timer = runtime.timers.setTimeout(() => {
          finish({
            kind: 'error',
            error: {
              kind: 'timeout',
              code: 'VALIDATOR_TIMEOUT',
              message: `The validator did not settle within ${options.validatorTimeoutMs}ms.`,
            },
          });
          validatorController.abort('validator-timeout');
        }, options.validatorTimeoutMs);
      }
      const fail = (thrown: unknown): void =>
        finish({
          kind: 'error',
          error: toValidatorError(thrown, { kind: 'execute', code: 'VALIDATOR_THREW' }),
        });
      try {
        Promise.resolve(validator.validate(input, validatorSignal)).then(
          (value) => finish(normalizeOutcome(value)),
          fail,
        );
      } catch (thrown) {
        fail(thrown);
      }
    });
  };

  // ---- one attempt -----------------------------------------------------------

  const attemptInput = (index: number, feedback: string | undefined): string => {
    if (index === 0) return prompt;
    const policy = conversationPolicy;
    if (policy.kind === 'continue') return feedback ?? prompt;
    if (policy.kind === 'fork-from-baseline' && feedback !== undefined) {
      return `${prompt}\n\n${feedback}`;
    }
    return prompt;
  };

  const failAttempt = (
    attempt: MutableAttempt,
    detail: string,
    attemptStatus: 'failed' | 'aborted' = 'failed',
  ): AttemptDirective => {
    attempt.status = attemptStatus;
    attempt.completedAt = runtime.clock.nowISO();
    finishGoal('failed', 'attempt-run-failed', { failureDetail: detail });
    return STOP;
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

  const decideRetryOrExhaust = (
    attempt: MutableAttempt,
    feedback: string | undefined,
    announce: () => void,
    failureDetail?: string,
  ): AttemptDirective => {
    // `goal.retrying` is not emitted here: it waits for the next attempt to open
    // (see openAttempt), so an exhausted or failed goal never announces a retry.
    if (budgetExceeded()) {
      finishGoal('exhausted', 'aggregate-budget-exceeded', {
        beforeTerminalEvent: announce,
        failureDetail,
      });
      return STOP;
    }
    if (attempts.length >= budget.maximumAttempts) {
      finishGoal('exhausted', 'attempt-limit-reached', {
        beforeTerminalEvent: announce,
        failureDetail,
      });
      return STOP;
    }
    transition('retrying');
    announce();
    return { next: 'retry', feedback: attempt.feedback ?? feedback };
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
    const stopWith = (
      next: GoalRunTerminalStatus,
      reason: GoalRunTerminalReason,
      extras: Omit<FinishExtras, 'beforeTerminalEvent'> = {},
    ): AttemptDirective => {
      finishGoal(next, reason, { ...extras, beforeTerminalEvent: announce });
      return STOP;
    };

    switch (outcome.kind) {
      case 'pass':
        return stopWith('succeeded', 'validator-passed');
      case 'fail':
        return outcome.retryable && retryOn.has('validator-fail-retryable')
          ? decideRetryOrExhaust(attempt, outcome.feedback, announce)
          : stopWith('failed', 'validator-fail-non-retryable');
      case 'error':
        return stopWith('failed', 'validator-infrastructure-error', {
          validatorError: outcome.error,
        });
      case 'unavailable':
        return retryOn.has('validator-unavailable')
          ? decideRetryOrExhaust(attempt, inputFeedback, announce)
          : stopWith('failed', 'validator-infrastructure-error', {
              validatorError: outcome.error,
              failureDetail: outcome.reason,
            });
      case 'canceled':
        // An operator abortAttempt() needs no retryOn entry; a validator that
        // reports `canceled` on its own still does.
        if (operatorAborted.has(attempt.attemptId)) {
          // Same carry-forward as the running-abort path: the aborted attempt
          // produced no verdict, so the next one resumes from the input it had.
          return decideRetryOrExhaust(attempt, inputFeedback, announce, OPERATOR_ABORT_DETAIL);
        }
        return retryOn.has('validator-canceled')
          ? decideRetryOrExhaust(attempt, inputFeedback, announce)
          : stopWith('failed', 'validator-infrastructure-error', {
              failureDetail: 'The validator was canceled.',
            });
      case 'indeterminate':
        return stopWith('failed', 'validator-infrastructure-error', {
          failureDetail: outcome.reason,
        });
    }
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
      outcome: freezeOutcome(outcome),
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
      finishGoal('failed', 'attempt-run-failed', {
        failureDetail: `Applying the conversation policy failed: ${messageOf(thrown)}`,
      });
      return STOP;
    }
    if (session === undefined || isTerminal()) return STOP;

    const attempt = openAttempt(index, attemptId, session, retryOf);
    if (isTerminal()) return STOP;
    if (operatorAborted.has(attemptId)) {
      // abortAttempt() named this attempt from a `goal.retrying` listener, before
      // its run existed: skip running it and apply the same retry-or-exhaust rule.
      attempt.status = 'aborted';
      attempt.completedAt = runtime.clock.nowISO();
      return decideRetryOrExhaust(attempt, feedback, () => {}, OPERATOR_ABORT_DETAIL);
    }
    let agentRun: AgentRun;
    try {
      agentRun = session.run(attemptInput(index, feedback));
    } catch (thrown) {
      return failAttempt(attempt, `Starting the inner run failed: ${messageOf(thrown)}`);
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
      return failAttempt(attempt, `The inner run rejected: ${messageOf(thrown)}`);
    } finally {
      snapshotSubscription?.unsubscribe();
    }
    adoptRunId(attempt, agentRun.snapshot().id);
    if (settled === undefined || isTerminal()) return STOP;

    const { value: result } = settled;
    attempt.finishReason = result.finishReason;
    accountUsage(attempt, result);
    // Only 'stop-condition' hands off to the validator.
    if (result.finishReason !== 'stop-condition') {
      const aborted = result.finishReason === 'aborted';
      if (aborted && operatorAborted.has(attempt.attemptId)) {
        // The operator ended this attempt alone: skip validation and move on.
        attempt.status = 'aborted';
        attempt.completedAt = runtime.clock.nowISO();
        return decideRetryOrExhaust(attempt, feedback, () => {}, OPERATOR_ABORT_DETAIL);
      }
      return failAttempt(
        attempt,
        `The inner run finished with ${result.finishReason}.`,
        aborted ? 'aborted' : 'failed',
      );
    }
    // An operator abort that landed after the run finished still wins: the
    // attempt is not validated, so there is no cost to account and nothing to fail.
    if (
      budget.maximumTotalCostUsd !== undefined &&
      result.costEstimate === undefined &&
      !operatorAborted.has(attemptId)
    ) {
      return failAttempt(
        attempt,
        'maximumTotalCostUsd is set but the attempt reported no costEstimate, so its cost cannot be accounted.',
      );
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

  if (
    options.requireDeterministicValidation === true &&
    validator.determinism !== 'deterministic'
  ) {
    finishGoal('failed', 'unsupported-validation', {
      failureDetail: 'The validator cannot supply the deterministic evidence this goal requires.',
    });
    return handle;
  }

  if (budget.maximumTotalDurationMs !== undefined) {
    durationTimer = runtime.timers.setTimeout(() => {
      if (isTerminal()) return;
      attemptController?.abort('aggregate-budget-exceeded');
      liveRun?.abort('aggregate-budget-exceeded');
      closeCurrentAttemptAsAborted();
      finishGoal('exhausted', 'aggregate-budget-exceeded');
    }, budget.maximumTotalDurationMs);
  }

  void runGoal().catch((thrown: unknown) => {
    if (isTerminal()) return;
    finishGoal('failed', 'attempt-run-failed', {
      failureDetail: `The goal controller failed unexpectedly: ${messageOf(thrown)}`,
    });
  });

  return handle;
}
