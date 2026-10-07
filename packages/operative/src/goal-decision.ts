/**
 * The pure decision core shared by the in-memory goal controller (`startGoal`,
 * COR-634) and the durable goal workflow (COR-851).
 *
 * Everything here is a function of its arguments: the COR-638 transition table,
 * the terminal-reason mapping, configuration validation, the retry / exhaust /
 * fail decision for an attempt, the fail-closed decoder for validator output,
 * and the JSON-safe projection of validator results. Neither controller owns a
 * second copy of any rule, so they cannot drift apart. No clocks, timers,
 * runtime services, or I/O live in this module.
 */

import { GoalConfigurationError, VALIDATOR_ERROR_KINDS, type ValidatorError } from './errors';
import type { GoalEventTerminalReason } from './events';
import type { ConversationPolicy } from './fresh-attempt/conversation-policy';
import type { FinishReason, JSONValue } from './types';

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
 * layer projects both with `projectValidatorOutcome` before persisting.
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

export interface GoalUsage {
  readonly attempts: number;
  readonly steps: number;
  readonly tokens: number;
  /** `undefined` until some attempt reports a `costEstimate`. */
  readonly costUsd: number | undefined;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES: readonly GoalRunStatus[] = [
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

export type FailedReason = Extract<
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
export const TERMINAL_STATUS_BY_REASON: Readonly<
  Record<GoalRunTerminalReason, GoalRunTerminalStatus>
> = {
  'validator-passed': 'succeeded',
  'attempt-limit-reached': 'exhausted',
  'aggregate-budget-exceeded': 'exhausted',
  'validator-fail-non-retryable': 'failed',
  'validator-infrastructure-error': 'failed',
  'unsupported-validation': 'failed',
  'attempt-run-failed': 'failed',
  'goal-canceled': 'canceled',
};

export const isFailedReason = (reason: GoalRunTerminalReason): reason is FailedReason =>
  TERMINAL_STATUS_BY_REASON[reason] === 'failed';

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

const AGGREGATE_BOUND_KEYS = [
  'maximumTotalDurationMs',
  'maximumTotalSteps',
  'maximumTotalTokens',
  'maximumTotalCostUsd',
] as const;

/**
 * The slice of `StartGoalOptions` that configuration validation reads. A
 * `Validator` and a `StartGoalOptions` are both assignable to it.
 */
export interface GoalConfigurationInput {
  readonly validator: { readonly identity?: unknown; readonly validate?: unknown } | undefined;
  readonly budget: GoalBudget | undefined;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly conversationPolicy: unknown;
  readonly instructions?: string | undefined;
}

export function validateBudget(budget: GoalBudget | undefined): void {
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

export function validateRetryPolicy(policy: GoalRetryPolicy | undefined): void {
  if (policy === undefined) return;
  // `null` is not `undefined`: an untyped caller can send it, and it must read as
  // a policy with no list, not throw.
  const retryOn: unknown = (policy as { retryOn?: unknown } | null)?.retryOn;
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

export function validateConversationPolicy(
  conversationPolicy: unknown,
  instructions: string | undefined,
): void {
  const policy = conversationPolicy as { kind?: unknown; throughRun?: unknown } | undefined;
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
    if (typeof instructions !== 'string' || instructions.length === 0) {
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

/**
 * The user turn attempt `attemptIndex` is given, shared by the in-memory
 * controller and the durable one so the two cannot drift. The first attempt
 * runs the prompt. A retry under `continue` is the feedback alone, because the
 * transcript already holds the prompt; under `fork-from-baseline` it is the
 * prompt followed by the feedback, because the fork dropped the attempts that
 * carried it; under `fresh-from-artifact` it is the prompt again, because the
 * artifact is how the earlier attempt reaches the new conversation.
 */
export function goalAttemptInput(
  kind: GoalConversationPolicy['kind'],
  prompt: string,
  attemptIndex: number,
  feedback: string | undefined,
): string {
  if (attemptIndex === 0) return prompt;
  if (kind === 'continue') return feedback ?? prompt;
  if (kind === 'fork-from-baseline' && feedback !== undefined) return `${prompt}\n\n${feedback}`;
  return prompt;
}

export function validateGoalConfiguration(input: GoalConfigurationInput): void {
  const validator = input.validator as
    { identity?: { name?: unknown; version?: unknown }; validate?: unknown } | null | undefined;
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
  validateBudget(input.budget);
  validateRetryPolicy(input.retryPolicy);
  validateConversationPolicy(input.conversationPolicy, input.instructions);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What the controller does next. `retry` carries the feedback the next attempt receives. */
export type GoalDecision =
  | { readonly kind: 'succeed'; readonly reason: 'validator-passed' }
  | { readonly kind: 'retry'; readonly feedback: string | undefined }
  | {
      readonly kind: 'exhaust';
      readonly reason: 'attempt-limit-reached' | 'aggregate-budget-exceeded';
      readonly failureDetail?: string | undefined;
    }
  | {
      readonly kind: 'fail';
      readonly reason: FailedReason;
      readonly validatorError?: ValidatorError | undefined;
      readonly failureDetail?: string | undefined;
    }
  | { readonly kind: 'cancel'; readonly reason: 'goal-canceled' };

/** The state a decision reads. `usage.attempts` counts the current attempt. */
export interface GoalDecisionContext {
  readonly budget: GoalBudget;
  readonly retryOn: readonly GoalRetryableReason[];
  readonly usage: GoalUsage;
}

export const OPERATOR_ABORT_DETAIL =
  'The attempt was aborted with abortAttempt(), so it was not validated and no further attempt could start.';

/** The `failureDetail` of every site that ends a goal as `attempt-run-failed`. */
export const ATTEMPT_RUN_FAILURE_DETAIL = {
  conversationPolicy: (message: string): string =>
    `Applying the conversation policy failed: ${message}`,
  runStart: (message: string): string => `Starting the inner run failed: ${message}`,
  runRejected: (message: string): string => `The inner run rejected: ${message}`,
  runFinish: (finishReason: FinishReason): string => `The inner run finished with ${finishReason}.`,
  costUnaccounted:
    'maximumTotalCostUsd is set but the attempt reported no costEstimate, so its cost cannot be accounted.',
  controller: (message: string): string => `The goal controller failed unexpectedly: ${message}`,
} as const;

const START_FAILURE_PREFIXES = [
  ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy(''),
  ATTEMPT_RUN_FAILURE_DETAIL.runStart(''),
] as const;

/**
 * Whether a goal's `failureDetail` says the attempt's start failed (the
 * conversation policy could not be applied, or the run could not be started),
 * as opposed to a run that was started and then failed. Only the first can leave
 * a start in flight when the goal ends.
 */
export const isAttemptStartFailureDetail = (detail: string | undefined): boolean =>
  detail !== undefined && START_FAILURE_PREFIXES.some((prefix) => detail.startsWith(prefix));

const UNSUPPORTED_VALIDATION_DETAIL =
  'The validator cannot supply the deterministic evidence this goal requires.';
const VALIDATOR_CANCELED_DETAIL = 'The validator was canceled.';

export function isBudgetExceeded(budget: GoalBudget, usage: GoalUsage): boolean {
  return (
    (budget.maximumTotalDurationMs !== undefined &&
      usage.durationMs >= budget.maximumTotalDurationMs) ||
    (budget.maximumTotalSteps !== undefined && usage.steps >= budget.maximumTotalSteps) ||
    (budget.maximumTotalTokens !== undefined && usage.tokens >= budget.maximumTotalTokens) ||
    (budget.maximumTotalCostUsd !== undefined &&
      usage.costUsd !== undefined &&
      usage.costUsd >= budget.maximumTotalCostUsd)
  );
}

/**
 * Retry while headroom remains, otherwise exhaust. The aggregate budget is
 * checked before the attempt count, so a goal that crossed both reports the
 * budget. `failureDetail` is recorded on an exhaust decision only.
 */
export function decideRetryOrExhaust(
  context: GoalDecisionContext,
  feedback: string | undefined,
  failureDetail?: string,
): GoalDecision {
  const detail = failureDetail === undefined ? {} : { failureDetail };
  if (isBudgetExceeded(context.budget, context.usage)) {
    return { kind: 'exhaust', reason: 'aggregate-budget-exceeded', ...detail };
  }
  if (context.usage.attempts >= context.budget.maximumAttempts) {
    return { kind: 'exhaust', reason: 'attempt-limit-reached', ...detail };
  }
  return { kind: 'retry', feedback };
}

export interface GoalOutcomeInput {
  readonly outcome: ValidatorOutcome;
  /** The feedback the evaluated attempt itself received. */
  readonly inputFeedback: string | undefined;
  /** The operator ended this attempt with `abortAttempt()`. */
  readonly operatorAborted: boolean;
}

/** COR-638's outcome table: one validator outcome to one decision. */
export function decideOutcome(
  context: GoalDecisionContext,
  { outcome, inputFeedback, operatorAborted }: GoalOutcomeInput,
): GoalDecision {
  const retryOn = new Set(context.retryOn);
  const infrastructureFailure = (
    extras: { validatorError?: ValidatorError; failureDetail?: string } = {},
  ): GoalDecision => ({ kind: 'fail', reason: 'validator-infrastructure-error', ...extras });

  switch (outcome.kind) {
    case 'pass':
      return { kind: 'succeed', reason: 'validator-passed' };
    case 'fail':
      return outcome.retryable && retryOn.has('validator-fail-retryable')
        ? decideRetryOrExhaust(context, outcome.feedback)
        : { kind: 'fail', reason: 'validator-fail-non-retryable' };
    case 'error':
      return infrastructureFailure({ validatorError: outcome.error });
    case 'unavailable':
      return retryOn.has('validator-unavailable')
        ? decideRetryOrExhaust(context, inputFeedback)
        : infrastructureFailure({ validatorError: outcome.error, failureDetail: outcome.reason });
    case 'canceled':
      // An operator abortAttempt() needs no retryOn entry; a validator that
      // reports `canceled` on its own still does. The aborted attempt produced
      // no verdict, so the next one resumes from the input it had.
      if (operatorAborted) {
        return decideRetryOrExhaust(context, inputFeedback, OPERATOR_ABORT_DETAIL);
      }
      return retryOn.has('validator-canceled')
        ? decideRetryOrExhaust(context, inputFeedback)
        : infrastructureFailure({ failureDetail: VALIDATOR_CANCELED_DETAIL });
    case 'indeterminate':
      return infrastructureFailure({ failureDetail: outcome.reason });
  }
}

export interface GoalRunFinishInput {
  readonly finishReason: FinishReason;
  readonly operatorAborted: boolean;
  /** Whether the finished run reported a `costEstimate`. */
  readonly costEstimateReported: boolean;
  /** The feedback the finished attempt itself received. */
  readonly feedback: string | undefined;
}

export type GoalRunFinishDecision =
  | { readonly kind: 'validate' }
  | {
      readonly kind: 'decision';
      readonly decision: GoalDecision;
      readonly attemptStatus: 'failed' | 'aborted';
    };

/**
 * FinishReason mapping: only `'stop-condition'` hands off to the validator.
 * Any other reason skips validation and ends the attempt, unless the operator
 * aborted that attempt alone, which moves on to the next one.
 */
export function decideRunFinish(
  context: GoalDecisionContext,
  input: GoalRunFinishInput,
): GoalRunFinishDecision {
  if (input.finishReason !== 'stop-condition') {
    const aborted = input.finishReason === 'aborted';
    if (aborted && input.operatorAborted) {
      return {
        kind: 'decision',
        attemptStatus: 'aborted',
        decision: decideRetryOrExhaust(context, input.feedback, OPERATOR_ABORT_DETAIL),
      };
    }
    return {
      kind: 'decision',
      attemptStatus: aborted ? 'aborted' : 'failed',
      decision: decideAttemptRunFailure(ATTEMPT_RUN_FAILURE_DETAIL.runFinish(input.finishReason)),
    };
  }
  // An operator abort that landed after the run finished still wins: the
  // attempt is not validated, so there is no cost to account and nothing to fail.
  if (
    context.budget.maximumTotalCostUsd !== undefined &&
    !input.costEstimateReported &&
    !input.operatorAborted
  ) {
    return {
      kind: 'decision',
      attemptStatus: 'failed',
      decision: decideAttemptRunFailure(ATTEMPT_RUN_FAILURE_DETAIL.costUnaccounted),
    };
  }
  return { kind: 'validate' };
}

/** Every `attempt-run-failed` site funnels through here with its own detail. */
export function decideAttemptRunFailure(failureDetail: string): GoalDecision {
  return { kind: 'fail', reason: 'attempt-run-failed', failureDetail };
}

/** `unsupported-validation`, or `undefined` when the validator satisfies the goal's requirement. */
export function decideDeterminismRequirement(
  required: boolean | undefined,
  determinism: 'deterministic' | 'stochastic' | undefined,
): GoalDecision | undefined {
  if (required !== true || determinism === 'deterministic') return undefined;
  return {
    kind: 'fail',
    reason: 'unsupported-validation',
    failureDetail: UNSUPPORTED_VALIDATION_DETAIL,
  };
}

/** Whether the aggregate duration bound is spent. One reading for the in-memory and the durable controller. */
export function isDurationBoundElapsed(budget: GoalBudget, durationMs: number): boolean {
  return budget.maximumTotalDurationMs !== undefined && durationMs >= budget.maximumTotalDurationMs;
}

/** The aggregate duration bound elapsed. */
export function decideDurationElapsed(): GoalDecision {
  return { kind: 'exhaust', reason: 'aggregate-budget-exceeded' };
}

export function decideCancellation(): GoalDecision {
  return { kind: 'cancel', reason: 'goal-canceled' };
}

// ---------------------------------------------------------------------------
// Validator output normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function isEvidenceList(value: unknown): value is readonly ValidatorEvidence[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isRecord(entry) && typeof (entry as { source?: unknown }).source === 'string',
    )
  );
}

/**
 * A malformed return value is a validator infrastructure failure (`error`,
 * kind `'output'`), never a verdict.
 */
export function normalizeValidatorOutcome(value: unknown): ValidatorOutcome {
  if (!isRecord(value)) return malformedOutput('expected an object');
  switch (value['kind']) {
    case 'pass':
      return isEvidenceList(value['evidence'])
        ? { kind: 'pass', evidence: value['evidence'] }
        : malformedOutput('pass requires an evidence array of objects with a string source');
    case 'fail':
      return typeof value['feedback'] === 'string' &&
        isEvidenceList(value['evidence']) &&
        typeof value['retryable'] === 'boolean'
        ? {
            kind: 'fail',
            feedback: value['feedback'],
            evidence: value['evidence'],
            retryable: value['retryable'],
          }
        : malformedOutput(
            'fail requires feedback, an evidence array of objects with a string source, and retryable',
          );
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

/**
 * Detaches a recorded outcome from the validator's own objects and freezes it,
 * so neither the validator nor a caller can rewrite recorded history. `detail`
 * and `cause` values stay as the validator supplied them.
 */
export function freezeValidatorOutcome(outcome: ValidatorOutcome): ValidatorOutcome {
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

// ---------------------------------------------------------------------------
// JSON-safe projection
// ---------------------------------------------------------------------------

const MAXIMUM_PROJECTION_DEPTH = 32;
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNSERIALIZABLE = '[Unserializable]';

/** `undefined`, a function, or a symbol: dropped from an object, `null` elsewhere. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function projectNode(value: unknown, ancestors: object[], depth: number): JSONValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
  }
  const object = value;
  if (ancestors.includes(object)) return CIRCULAR;
  if (depth >= MAXIMUM_PROJECTION_DEPTH) return TRUNCATED;
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? null : object.toISOString();
  }
  const nextAncestors = [...ancestors, object];
  const projectChild = (child: unknown): JSONValue => projectNode(child, nextAncestors, depth + 1);
  if (object instanceof Error) {
    const projected: Record<string, JSONValue> = {
      name: object.name,
      message: object.message,
    };
    if (object.cause !== undefined) projected['cause'] = projectChild(object.cause);
    return projected;
  }
  if (Array.isArray(object)) return object.map(projectChild);
  if (object instanceof Set) return [...object].map(projectChild);
  if (object instanceof Map) {
    return [...object.entries()].map(([key, entry]) => [projectChild(key), projectChild(entry)]);
  }
  const withToJson = object as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') {
    return projectChild((withToJson.toJSON as () => unknown).call(object));
  }
  const entries: [string, JSONValue][] = [];
  for (const key of Object.keys(object)) {
    let child: unknown;
    try {
      child = (object as Record<string, unknown>)[key];
    } catch {
      entries.push([key, UNSERIALIZABLE]);
      continue;
    }
    if (!isOmitted(child)) entries.push([key, projectChild(child)]);
  }
  // `fromEntries` defines own properties, so a key such as `__proto__` stays data.
  return Object.fromEntries(entries);
}

/**
 * Projects any value to a JSON-safe form without throwing: cycles, depth,
 * throwing getters and `toJSON`, bigints, dates, errors (name and message,
 * never a stack), maps, and sets are all handled. A durable layer persists
 * the projection, never the original.
 */
export function toJsonSafe(value: unknown): JSONValue {
  try {
    return projectNode(value, [], 0);
  } catch {
    return UNSERIALIZABLE;
  }
}

export interface ProjectedValidatorError {
  readonly kind: ValidatorError['kind'];
  readonly code: string;
  readonly message: string;
  readonly cause?: JSONValue;
}

export interface ProjectedValidatorEvidence {
  readonly source: string;
  readonly detail: JSONValue;
}

export type ProjectedValidatorOutcome =
  | { readonly kind: 'pass'; readonly evidence: readonly ProjectedValidatorEvidence[] }
  | {
      readonly kind: 'fail';
      readonly feedback: string;
      readonly evidence: readonly ProjectedValidatorEvidence[];
      readonly retryable: boolean;
    }
  | { readonly kind: 'error'; readonly error: ProjectedValidatorError }
  | {
      readonly kind: 'unavailable';
      readonly error: ProjectedValidatorError;
      readonly reason: string;
    }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface ProjectedValidatorResult {
  readonly identity: ValidatorIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ProjectedValidatorOutcome;
}

/** The error as a durable record keeps it: `cause` projected to JSON, never dropped. */
export function projectValidatorError(error: ValidatorError): ProjectedValidatorError {
  return {
    kind: error.kind,
    code: error.code,
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: toJsonSafe(error.cause) }),
  };
}

/** The error as an event carries it: `cause` can hold arbitrary validator internals. */
export function stripValidatorErrorCause(error: ValidatorError): ValidatorError {
  return { kind: error.kind, code: error.code, message: error.message };
}

const projectEvidence = (
  evidence: readonly ValidatorEvidence[],
): readonly ProjectedValidatorEvidence[] =>
  evidence.map((item) => ({ source: item.source, detail: toJsonSafe(item.detail) }));

export function projectValidatorOutcome(outcome: ValidatorOutcome): ProjectedValidatorOutcome {
  switch (outcome.kind) {
    case 'pass':
      return { kind: 'pass', evidence: projectEvidence(outcome.evidence) };
    case 'fail':
      return {
        kind: 'fail',
        feedback: outcome.feedback,
        evidence: projectEvidence(outcome.evidence),
        retryable: outcome.retryable,
      };
    case 'error':
      return { kind: 'error', error: projectValidatorError(outcome.error) };
    case 'unavailable':
      return {
        kind: 'unavailable',
        error: projectValidatorError(outcome.error),
        reason: outcome.reason,
      };
    case 'canceled':
      return { kind: 'canceled' };
    case 'indeterminate':
      return { kind: 'indeterminate', reason: outcome.reason };
  }
}

export function projectValidatorResult(result: ValidatorResult): ProjectedValidatorResult {
  return {
    identity: { name: result.identity.name, version: result.identity.version },
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    outcome: projectValidatorOutcome(result.outcome),
  };
}
