/**
 * COR-851 — the durable record of one Bureau goal run.
 *
 * `GoalState` is the inspectable projection every controller transition
 * commits to. It holds plain JSON only: the objective (an agent *name* and
 * its prompt, never a closure), the validator's pinned identity, the
 * conversation policy, the bounds, one record per attempt, the aggregate
 * usage, the last committed transition, and the two pieces of control-plane
 * state — the cancellation marker and the controller restart count.
 *
 * Two counters keep concurrent writers honest. `revision` advances on EVERY
 * successful write (a controller transition or a control-plane write) and is
 * the compare-and-swap token. `transitionSeq` advances only on a controller
 * state-machine transition, so a replayed workflow re-issues byte-identical
 * commits and the store can recognise them.
 *
 * The decoder is hand-written and fail-closed, like `isChildRecord` in
 * `child-topology-store.ts`: a record that does not decode to its exact shape
 * (including the terminal-status/terminal-reason pairing the COR-638 table
 * requires) is treated as absent and reported, never trusted as a partial
 * value.
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type FinishReason,
  freshAttemptHandoffArtifactSchema,
  GOAL_RUN_AND_SESSION_ID_PREFIX,
  GOAL_WORKFLOW_ID_PREFIX,
  type GoalBudget,
  GoalConfigurationError,
  type GoalConversationPolicy,
  type GoalIdentity,
  type GoalRetryPolicy,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type JSONValue,
  type ProjectedValidatorError,
  type ProjectedValidatorOutcome,
  TERMINAL_STATUS_BY_REASON,
  TERMINAL_STATUSES,
  validateBudget,
  validateConversationPolicy,
  validateRetryPolicy,
  VALIDATOR_ERROR_KINDS,
  type ValidatorIdentity,
} from '@lostgradient/operative';

// ---------------------------------------------------------------------------
// Caps, keys, and identifiers
// ---------------------------------------------------------------------------

/**
 * Version 2 added `auditLog`. The decoder accepts exactly this version and
 * nothing older: the template is pre-release, so a version-1 record is
 * reported corrupt rather than migrated.
 */
export const GOAL_STATE_SCHEMA_VERSION = 2 as const;

/**
 * The most attempts a durable goal may be bounded to. It bounds the record
 * itself (one entry per attempt) and, through it, {@link GOAL_AUDIT_LOG_MAXIMUM_ENTRIES}.
 */
export const GOAL_MAXIMUM_ATTEMPTS = 256;

/**
 * The most entries `auditLog` may hold. Each attempt commits at most three
 * transitions (`running`, `evaluating`, then `retrying` or a terminal one)
 * plus the first `pending -> running`, and boot recovery restarts a
 * controller a handful of times, so `4 * GOAL_MAXIMUM_ATTEMPTS + 8` is above
 * anything a goal bounded by {@link GOAL_MAXIMUM_ATTEMPTS} can reach. The store
 * refuses a write that would pass it rather than drop an entry, so an audit
 * event is never silently lost to the cap.
 */
export const GOAL_AUDIT_LOG_MAXIMUM_ENTRIES = 4 * GOAL_MAXIMUM_ATTEMPTS + 8;

/**
 * The objective is stored inline. `prompt` plus `instructions` (UTF-8 bytes)
 * above this ceiling is rejected up front with {@link GoalObjectiveTooLargeError}
 * rather than written and later truncated.
 */
export const GOAL_OBJECTIVE_MAXIMUM_BYTES = 65_536;

/**
 * One attempt's validation outcome is stored inline too. `boundValidationOutcome`
 * brings an over-cap outcome under this ceiling; the store refuses anything
 * that is still over it.
 */
export const GOAL_VALIDATION_MAXIMUM_BYTES = 65_536;

/** Never a Weft-reserved prefix (see `WEFT_RESERVED_KEY_PREFIXES`). */
export const GOAL_RECORD_KEY_PREFIX = 'bureau-goal:record:';

// `encodeURIComponent` escapes `:`, so identifiers containing separators
// cannot collide with another record's key.
export function goalRecordKey(goalRunId: string): string {
  return `${GOAL_RECORD_KEY_PREFIX}${encodeURIComponent(goalRunId)}`;
}

/** The id the `cancel` signal is sent under; stable, so a re-send is delivered once. */
export const cancelSignalId = (goalRunId: string): string => `cancel:${goalRunId}`;
/** The id an attempt's ending is signalled under; stable, so a re-send is delivered once. */
export const attemptSignalId = (goalRunId: string, attemptIndex: number): string =>
  `attempt-terminal:${goalRunId}:${attemptIndex}`;

/** The Weft workflow that owns this goal; an explicit id makes a duplicate start refusable. */
export const goalWorkflowId = (goalRunId: string): string =>
  `${GOAL_WORKFLOW_ID_PREFIX}${goalRunId}`;
export const goalTransitionId = (goalRunId: string, seq: number): string => `${goalRunId}:t${seq}`;
/** The id of the log entry for a goal's `count`-th counted controller restart. */
export const goalRestartId = (goalRunId: string, count: number): string =>
  `${goalRunId}:restart-${count}`;
export const goalAttemptId = (goalRunId: string, attemptIndex: number): string =>
  `${goalRunId}:a${attemptIndex}`;
/** Deterministic, so a restart that re-starts attempt N finds attempt N's run, never N+1's. */
export const goalAttemptRunId = (goalRunId: string, attemptIndex: number): string =>
  `${GOAL_RUN_AND_SESSION_ID_PREFIX}${goalRunId}-a${attemptIndex}`;
/** The first session of a goal: attempt 0 runs here, and under `continue` so does every other attempt. */
export const goalSessionId = (goalRunId: string, attemptIndex: number): string =>
  `${GOAL_RUN_AND_SESSION_ID_PREFIX}${goalRunId}-s${attemptIndex}`;

/** The session attempt `attemptIndex` runs in under the goal's policy. */
export function attemptSessionId(
  goalRunId: string,
  kind: GoalConversationPolicy['kind'],
  attemptIndex: number,
): string {
  return goalSessionId(goalRunId, kind === 'continue' || attemptIndex === 0 ? 0 : attemptIndex);
}
/** The first committed decision for an attempt wins; a re-executed validator cannot add a second. */
export const goalDecisionId = (attemptId: string): string => `${attemptId}:decision`;

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface GoalObjective {
  /** The agent is resolved by NAME from the Bureau catalog on every use. */
  readonly agentName: string;
  readonly prompt: string;
  readonly instructions?: string | undefined;
}

export interface DurableGoalAttemptUsage {
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
}

/** The aggregate: `costUsd` stays absent until some attempt reports a cost. */
export interface DurableGoalUsage {
  readonly attempts: number;
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  readonly durationMs: number;
}

export type DurableGoalAttemptStatus = 'running' | 'evaluating' | 'passed' | 'failed' | 'aborted';

export interface DurableGoalValidation {
  readonly identity: ValidatorIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  /** JSON-safe: `ValidatorError.cause` and evidence `detail` are already projected. */
  readonly outcome: ProjectedValidatorOutcome;
  readonly decisionId: string;
}

export interface DurableGoalAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly runId: string;
  /** The goal session the attempt's run is recorded in (`goalSessionId`): the trunk, or the fork or fresh session of a retry. */
  readonly sessionId: string;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly validation?: DurableGoalValidation | undefined;
  readonly feedback?: string | undefined;
  readonly usage: DurableGoalAttemptUsage;
  readonly status: DurableGoalAttemptStatus;
}

/** What is in flight right now; cleared when its result commits. */
export type ActiveGoalWork =
  | {
      readonly kind: 'attempt';
      readonly attemptId: string;
      readonly runId: string;
      readonly startedAt: string;
    }
  | {
      readonly kind: 'validation';
      readonly attemptId: string;
      readonly validator: ValidatorIdentity;
      readonly startedAt: string;
    };

/**
 * One audit event, already derived and JSON-safe. It carries exactly what the
 * durable event history would record (ids, statuses, reasons, a digest of
 * feedback; never evidence, raw feedback, or `ValidatorError.cause`), so a
 * replay needs nothing but the log.
 */
export interface GoalAuditEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, JSONValue>>;
  /** The durable history's idempotency key for this event. */
  readonly dedupeKey: string;
  /** ISO-8601: the commit's own timestamp, never the moment of a replay. */
  readonly at: string;
}

/**
 * One committed write that implies audit events: a controller transition or a
 * counted controller restart. Appended in the SAME compare-and-swap commit as
 * the write, so the log and the state can never disagree, and it is never
 * rewritten. `events` may be empty (a transition such as `evaluating` implies
 * none). A transition entry's `transitionId` is `goalTransitionId(id, seq)`; a
 * restart entry's is `goalRestartId(id, n)` and its `seq` is the transition
 * the goal was at.
 */
export interface GoalAuditEntry {
  readonly seq: number;
  readonly transitionId: string;
  readonly events: readonly GoalAuditEvent[];
}

export interface GoalTransitionRecord {
  /** Equals the record's `transitionSeq`. */
  readonly seq: number;
  readonly transitionId: string;
  readonly from: GoalRunStatus;
  readonly to: GoalRunStatus;
  readonly at: string;
  readonly cause: string;
}

/**
 * An operator asked this goal to stop. Authoritative: the controller re-reads
 * the record at each decision point, and the cancel signal is only an
 * optimisation. Written by the control plane, never by a controller
 * transition.
 */
export interface GoalCancellationMarker {
  readonly requestedAt: string;
  readonly principal?: string | undefined;
  readonly reason?: string | undefined;
}

export interface GoalState {
  readonly schemaVersion: typeof GOAL_STATE_SCHEMA_VERSION;
  readonly goalRunId: string;
  readonly workflowId: string;
  /** Starts at `1`; every accepted write advances it by exactly one. */
  readonly revision: number;
  /** Starts at `0`; advances only on a controller transition. */
  readonly transitionSeq: number;
  readonly identity: GoalIdentity;
  readonly objective: GoalObjective;
  /** Pinned at create time; resolved from the validator catalog on every use. */
  readonly validator: ValidatorIdentity;
  readonly requireDeterministicValidation: boolean;
  readonly validatorTimeoutMs?: number | undefined;
  readonly conversationPolicy: GoalConversationPolicy;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly bounds: GoalBudget;
  /** The principal that owns this goal. */
  readonly principal?: string | undefined;
  readonly status: GoalRunStatus;
  /** Present exactly when `status` is terminal, and always mapped to that status. */
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  readonly currentTransition: GoalTransitionRecord;
  readonly attempts: readonly DurableGoalAttempt[];
  readonly usage: DurableGoalUsage;
  readonly active?: ActiveGoalWork | undefined;
  readonly cancellation?: GoalCancellationMarker | undefined;
  /** How many times boot recovery restarted a controller that ended abnormally. */
  readonly controllerRestarts: number;
  /**
   * The append-only audit transition log, bounded by
   * {@link GOAL_AUDIT_LOG_MAXIMUM_ENTRIES}. Boot re-projection replays it, so an
   * audit event whose live projection failed is repaired whenever it was
   * committed, not only while it is the current transition.
   */
  readonly auditLog: readonly GoalAuditEntry[];
  /** Set once by `close()`; terminal records only. */
  readonly closedAt?: string | undefined;
  /**
   * Set once the bureau's checkpoint retention has been applied to everything
   * the goal ran, and only on a closed goal. A goal closed without this is one
   * whose cleanup is still owed (the process died after committing `closedAt`,
   * or a part could not be pruned), which the boot sweep finishes.
   */
  readonly cleanedUpAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The objective's `prompt` plus `instructions` exceeds {@link GOAL_OBJECTIVE_MAXIMUM_BYTES}. */
export class GoalObjectiveTooLargeError extends Error {
  readonly byteLength: number;
  readonly maximumBytes: number;

  constructor(byteLength: number, maximumBytes: number = GOAL_OBJECTIVE_MAXIMUM_BYTES) {
    super(
      `Bureau goal objective is ${byteLength} bytes; the inline limit is ${maximumBytes} bytes.`,
    );
    this.name = 'GoalObjectiveTooLargeError';
    this.byteLength = byteLength;
    this.maximumBytes = maximumBytes;
  }
}

/** The goal id cannot be used to name the workflows and signals a goal is made of. */
export class GoalRunIdError extends Error {
  readonly reason: 'empty' | 'control-character' | 'malformed' | 'too-long';

  constructor(reason: GoalRunIdError['reason'], message: string) {
    super(message);
    this.name = 'GoalRunIdError';
    this.reason = reason;
  }
}

/** A `GoalState` the store was asked to write does not decode to its exact shape. */
export class InvalidGoalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGoalStateError';
  }
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function objectiveByteLength(objective: GoalObjective): number {
  return utf8ByteLength(objective.prompt) + utf8ByteLength(objective.instructions ?? '');
}

export function validationByteLength(validation: DurableGoalValidation): number {
  return utf8ByteLength(JSON.stringify(validation.outcome));
}

const TEXT_MAXIMUM_CHARACTERS = 4096;

const truncateText = (text: string): string =>
  text.length <= TEXT_MAXIMUM_CHARACTERS ? text : `${text.slice(0, TEXT_MAXIMUM_CHARACTERS)}…`;

function truncationMarker(value: JSONValue): JSONValue {
  return { truncated: true, originalByteLength: utf8ByteLength(JSON.stringify(value)) };
}

function boundError(error: ProjectedValidatorError): ProjectedValidatorError {
  const { cause, ...rest } = error;
  return {
    ...rest,
    message: truncateText(error.message),
    ...(cause === undefined ? {} : { cause: truncationMarker(cause) }),
  };
}

const COMPACT_TEXT_CHARACTERS = 256;
const COMPACT_SOURCE_CHARACTERS = 128;
const COMPACT_CODE_CHARACTERS = 64;
/** Evidence past this many entries is dropped in the second tier, however small each is. */
const MAXIMUM_BOUNDED_EVIDENCE_ENTRIES = 512;

/** The code of the outcome that replaces one that could not be brought under the cap. */
export const VALIDATION_OUTCOME_TOO_LARGE = 'OUTCOME_TOO_LARGE';

/** Cuts to `maximum` UTF-16 units without leaving half of a surrogate pair behind. */
function cut(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const end = /[\ud800-\udbff]/.test(text.charAt(maximum - 1)) ? maximum - 1 : maximum;
  return `${text.slice(0, end)}…`;
}

const fitsWithin = (outcome: ProjectedValidatorOutcome, maximumBytes: number): boolean =>
  utf8ByteLength(JSON.stringify(outcome)) <= maximumBytes;

type EvidenceList = readonly { source: string; detail: JSONValue }[];

/** First tier: details and causes become markers; free text is cut to a few thousand characters. */
function boundFirstTier(outcome: ProjectedValidatorOutcome): ProjectedValidatorOutcome {
  const evidence = (items: EvidenceList) =>
    items.map((item) => ({ source: item.source, detail: truncationMarker(item.detail) }));
  switch (outcome.kind) {
    case 'pass':
      return { kind: 'pass', evidence: evidence(outcome.evidence) };
    case 'fail':
      return {
        kind: 'fail',
        feedback: truncateText(outcome.feedback),
        evidence: evidence(outcome.evidence),
        retryable: outcome.retryable,
      };
    case 'error':
      return { kind: 'error', error: boundError(outcome.error) };
    case 'unavailable':
      return {
        kind: 'unavailable',
        error: boundError(outcome.error),
        reason: truncateText(outcome.reason),
      };
    case 'canceled':
      return outcome;
    case 'indeterminate':
      return { kind: 'indeterminate', reason: truncateText(outcome.reason) };
  }
}

/**
 * Second tier: every string is short, and evidence is cut to as many entries as
 * fit (a marker says how many were dropped). The verdict is still the validator's.
 */
function boundSecondTier(
  outcome: ProjectedValidatorOutcome,
  maximumBytes: number,
): ProjectedValidatorOutcome | undefined {
  const compactError = (error: ProjectedValidatorError): ProjectedValidatorError => {
    const { cause, ...rest } = error;
    return {
      ...rest,
      code: cut(error.code, COMPACT_CODE_CHARACTERS),
      message: cut(error.message, COMPACT_TEXT_CHARACTERS),
      ...(cause === undefined ? {} : { cause: truncationMarker(cause) }),
    };
  };
  const withEvidence = (
    items: EvidenceList,
    build: (evidence: EvidenceList) => ProjectedValidatorOutcome,
  ): ProjectedValidatorOutcome | undefined => {
    const considered = items.slice(0, MAXIMUM_BOUNDED_EVIDENCE_ENTRIES).map((item) => ({
      source: cut(item.source, COMPACT_SOURCE_CHARACTERS),
      detail: truncationMarker(item.detail),
    }));
    const candidate = (keep: number): ProjectedValidatorOutcome =>
      build(
        keep === items.length
          ? considered.slice(0, keep)
          : [
              ...considered.slice(0, keep),
              { source: 'omitted', detail: { omittedEntries: items.length - keep } },
            ],
      );
    // Fitting is monotonic in the number of entries kept, so search for the most that fit.
    let low = 0;
    let high = considered.length;
    if (!fitsWithin(candidate(0), maximumBytes)) return undefined;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitsWithin(candidate(middle), maximumBytes)) low = middle;
      else high = middle - 1;
    }
    return candidate(low);
  };
  switch (outcome.kind) {
    case 'pass':
      return withEvidence(outcome.evidence, (evidence) => ({ kind: 'pass', evidence }));
    case 'fail':
      return withEvidence(outcome.evidence, (evidence) => ({
        kind: 'fail',
        feedback: cut(outcome.feedback, COMPACT_TEXT_CHARACTERS),
        evidence,
        retryable: outcome.retryable,
      }));
    case 'error':
      return { kind: 'error', error: compactError(outcome.error) };
    case 'unavailable':
      return {
        kind: 'unavailable',
        error: compactError(outcome.error),
        reason: cut(outcome.reason, COMPACT_TEXT_CHARACTERS),
      };
    case 'indeterminate':
      return { kind: 'indeterminate', reason: cut(outcome.reason, COMPACT_TEXT_CHARACTERS) };
    case 'canceled':
      return outcome;
  }
}

/**
 * Brings a validator outcome under `maximumBytes`, and guarantees it stays there.
 *
 * 1. An outcome already under the ceiling is returned untouched.
 * 2. Otherwise every evidence `detail` and `ValidatorError.cause` becomes a
 *    `{ truncated, originalByteLength }` marker and free text is cut to a fixed
 *    length. The verdict (`kind`, `retryable`, the `source`s) does not change.
 * 3. If that is still over (a great many entries, or very long sources, codes,
 *    or multi-byte text), strings are cut short and evidence is cut to as many
 *    entries as fit, with a marker for the rest. The verdict still does not change.
 * 4. If even that cannot fit, the outcome is replaced by a validator
 *    infrastructure `error` coded {@link VALIDATION_OUTCOME_TOO_LARGE}. That is
 *    deliberate: a verdict nobody can record is not one the goal may act on.
 *
 * Only a ceiling below the size of that replacement (a few dozen bytes) cannot
 * be honoured; the record's own cap is orders of magnitude above it.
 */
export function boundValidationOutcome(
  outcome: ProjectedValidatorOutcome,
  maximumBytes: number = GOAL_VALIDATION_MAXIMUM_BYTES,
): ProjectedValidatorOutcome {
  if (fitsWithin(outcome, maximumBytes) || outcome.kind === 'canceled') return outcome;
  const first = boundFirstTier(outcome);
  if (fitsWithin(first, maximumBytes)) return first;
  const second = boundSecondTier(outcome, maximumBytes);
  if (second !== undefined && fitsWithin(second, maximumBytes)) return second;
  return {
    kind: 'error',
    error: { kind: 'output', code: VALIDATION_OUTCOME_TOO_LARGE, message: 'Outcome too large.' },
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type PlainRecord = Record<string, unknown>;

const isPlainRecord = (value: unknown): value is PlainRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A finite, calendar-valid ISO-8601 instant with a time and a zone. A string
 * that merely parses is not enough: `Date.parse` rolls `2026-02-31` over into
 * March, and a timestamp the elapsed-time arithmetic cannot read would count as
 * no time at all, so a duration-bounded goal would never spend its budget.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (!isString(value)) return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

const isTimestamp = isIsoTimestamp;
const isOptionalTimestamp = (value: unknown): boolean =>
  value === undefined || isIsoTimestamp(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isOptionalNonNegativeNumber = (value: unknown): boolean =>
  value === undefined || isNonNegativeNumber(value);

const hasExactKeys = (value: PlainRecord, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const MAXIMUM_JSON_DEPTH = 64;

function isJsonValue(value: unknown, depth = 0): value is JSONValue {
  if (depth > MAXIMUM_JSON_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const GOAL_STATUSES: Readonly<Record<GoalRunStatus, true>> = {
  pending: true,
  running: true,
  evaluating: true,
  retrying: true,
  succeeded: true,
  exhausted: true,
  failed: true,
  canceled: true,
};

const FINISH_REASONS: Readonly<Record<FinishReason, true>> = {
  'stop-condition': true,
  'maximum-steps': true,
  aborted: true,
  error: true,
  'elicitation-denied': true,
  'budget-exceeded': true,
  tripwire: true,
};

const ATTEMPT_STATUSES: Readonly<Record<DurableGoalAttemptStatus, true>> = {
  running: true,
  evaluating: true,
  passed: true,
  failed: true,
  aborted: true,
};

const hasKey = (table: object, key: unknown): boolean => isString(key) && Object.hasOwn(table, key);

export const isGoalRunStatus = (value: unknown): value is GoalRunStatus =>
  hasKey(GOAL_STATUSES, value);

/** Terminal statuses have no outgoing edge in COR-638's transition table. */
export const isTerminalGoalStatus = (status: GoalRunStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export const isGoalRunTerminalReason = (value: unknown): value is GoalRunTerminalReason =>
  hasKey(TERMINAL_STATUS_BY_REASON, value);

const isValidatorIdentity = (value: unknown): value is ValidatorIdentity =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['name', 'version']) &&
  isNonEmptyString(value['name']) &&
  isNonEmptyString(value['version']);

function isProjectedError(value: unknown): value is ProjectedValidatorError {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['kind', 'code', 'message', 'cause'])) {
    return false;
  }
  return (
    VALIDATOR_ERROR_KINDS.some((kind) => kind === value['kind']) &&
    isString(value['code']) &&
    isString(value['message']) &&
    (value['cause'] === undefined || isJsonValue(value['cause']))
  );
}

function isProjectedEvidence(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['source', 'detail']) &&
    isString(value['source']) &&
    isJsonValue(value['detail'])
  );
}

const isEvidenceList = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isProjectedEvidence);

type OutcomeCheck = (value: PlainRecord) => boolean;

const OUTCOME_CHECKS: Readonly<Record<ProjectedValidatorOutcome['kind'], OutcomeCheck>> = {
  pass: (value) => hasExactKeys(value, ['kind', 'evidence']) && isEvidenceList(value['evidence']),
  fail: (value) =>
    hasExactKeys(value, ['kind', 'feedback', 'evidence', 'retryable']) &&
    isString(value['feedback']) &&
    isEvidenceList(value['evidence']) &&
    typeof value['retryable'] === 'boolean',
  error: (value) => hasExactKeys(value, ['kind', 'error']) && isProjectedError(value['error']),
  unavailable: (value) =>
    hasExactKeys(value, ['kind', 'error', 'reason']) &&
    isProjectedError(value['error']) &&
    isString(value['reason']),
  canceled: (value) => hasExactKeys(value, ['kind']),
  indeterminate: (value) => hasExactKeys(value, ['kind', 'reason']) && isString(value['reason']),
};

export function isProjectedValidatorOutcome(value: unknown): value is ProjectedValidatorOutcome {
  if (!isPlainRecord(value)) return false;
  const kind = value['kind'];
  if (!isString(kind) || !Object.hasOwn(OUTCOME_CHECKS, kind)) return false;
  return OUTCOME_CHECKS[kind as ProjectedValidatorOutcome['kind']](value);
}

function isValidation(value: unknown): value is DurableGoalValidation {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['identity', 'startedAt', 'completedAt', 'outcome', 'decisionId']) &&
    isValidatorIdentity(value['identity']) &&
    isTimestamp(value['startedAt']) &&
    isTimestamp(value['completedAt']) &&
    isProjectedValidatorOutcome(value['outcome']) &&
    isNonEmptyString(value['decisionId'])
  );
}

function isAttemptUsage(value: unknown): value is DurableGoalAttemptUsage {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['steps', 'tokens', 'costUsd']) &&
    isNonNegativeNumber(value['steps']) &&
    isNonNegativeNumber(value['tokens']) &&
    isOptionalNonNegativeNumber(value['costUsd'])
  );
}

const ATTEMPT_KEYS = [
  'attemptId',
  'attemptIndex',
  'runId',
  'sessionId',
  'startedAt',
  'completedAt',
  'finishReason',
  'validation',
  'feedback',
  'usage',
  'status',
] as const;

export function isDurableGoalAttempt(value: unknown): value is DurableGoalAttempt {
  if (!isPlainRecord(value) || !hasExactKeys(value, ATTEMPT_KEYS)) return false;
  return (
    isNonEmptyString(value['attemptId']) &&
    isNonNegativeInteger(value['attemptIndex']) &&
    isNonEmptyString(value['runId']) &&
    isNonEmptyString(value['sessionId']) &&
    isTimestamp(value['startedAt']) &&
    isOptionalTimestamp(value['completedAt']) &&
    (value['finishReason'] === undefined || hasKey(FINISH_REASONS, value['finishReason'])) &&
    (value['validation'] === undefined || isValidation(value['validation'])) &&
    isOptionalString(value['feedback']) &&
    isAttemptUsage(value['usage']) &&
    hasKey(ATTEMPT_STATUSES, value['status'])
  );
}

function isActiveWork(value: unknown): value is ActiveGoalWork {
  if (!isPlainRecord(value)) return false;
  if (value['kind'] === 'attempt') {
    return (
      hasExactKeys(value, ['kind', 'attemptId', 'runId', 'startedAt']) &&
      isNonEmptyString(value['attemptId']) &&
      isNonEmptyString(value['runId']) &&
      isTimestamp(value['startedAt'])
    );
  }
  return (
    value['kind'] === 'validation' &&
    hasExactKeys(value, ['kind', 'attemptId', 'validator', 'startedAt']) &&
    isNonEmptyString(value['attemptId']) &&
    isValidatorIdentity(value['validator']) &&
    isTimestamp(value['startedAt'])
  );
}

function isTransitionRecord(value: unknown): value is GoalTransitionRecord {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['seq', 'transitionId', 'from', 'to', 'at', 'cause']) &&
    isNonNegativeInteger(value['seq']) &&
    isNonEmptyString(value['transitionId']) &&
    isGoalRunStatus(value['from']) &&
    isGoalRunStatus(value['to']) &&
    isTimestamp(value['at']) &&
    isString(value['cause'])
  );
}

function isAuditEvent(value: unknown): value is GoalAuditEvent {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['kind', 'payload', 'dedupeKey', 'at']) &&
    isNonEmptyString(value['kind']) &&
    isPlainRecord(value['payload']) &&
    isJsonValue(value['payload']) &&
    isNonEmptyString(value['dedupeKey']) &&
    isTimestamp(value['at'])
  );
}

function isAuditEntry(value: unknown): value is GoalAuditEntry {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['seq', 'transitionId', 'events']) &&
    isNonNegativeInteger(value['seq']) &&
    isNonEmptyString(value['transitionId']) &&
    Array.isArray(value['events']) &&
    value['events'].every(isAuditEvent)
  );
}

function isCancellationMarker(value: unknown): value is GoalCancellationMarker {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestedAt', 'principal', 'reason']) &&
    isTimestamp(value['requestedAt']) &&
    isOptionalString(value['principal']) &&
    isOptionalString(value['reason'])
  );
}

function isIdentity(value: unknown): value is GoalIdentity {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['name', 'version']) &&
    isNonEmptyString(value['name']) &&
    isNonEmptyString(value['version'])
  );
}

function isObjective(value: unknown): value is GoalObjective {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['agentName', 'prompt', 'instructions']) &&
    isNonEmptyString(value['agentName']) &&
    isString(value['prompt']) &&
    isOptionalString(value['instructions']) &&
    objectiveByteLength(value as unknown as GoalObjective) <= GOAL_OBJECTIVE_MAXIMUM_BYTES
  );
}

function isUsage(value: unknown): value is DurableGoalUsage {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['attempts', 'steps', 'tokens', 'costUsd', 'durationMs']) &&
    isNonNegativeInteger(value['attempts']) &&
    isNonNegativeNumber(value['steps']) &&
    isNonNegativeNumber(value['tokens']) &&
    isOptionalNonNegativeNumber(value['costUsd']) &&
    isNonNegativeNumber(value['durationMs'])
  );
}

/** Reuses COR-638's own validators, so the durable record accepts exactly what `startGoal` does. */
function passes(check: () => void): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof GoalConfigurationError) return false;
    throw error;
  }
}

const BOUNDS_KEYS: readonly string[] = [
  'maximumAttempts',
  'maximumTotalDurationMs',
  'maximumTotalSteps',
  'maximumTotalTokens',
  'maximumTotalCostUsd',
];

function isBounds(value: unknown): value is GoalBudget {
  if (!isPlainRecord(value)) return false;
  return (
    hasExactKeys(value, BOUNDS_KEYS) &&
    passes(() => validateBudget(value as unknown as GoalBudget)) &&
    (value['maximumAttempts'] as number) <= GOAL_MAXIMUM_ATTEMPTS
  );
}

function isRetryPolicy(value: unknown): value is GoalRetryPolicy {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['retryOn']) &&
    passes(() => validateRetryPolicy(value as unknown as GoalRetryPolicy))
  );
}

function isConversationPolicy(value: unknown, instructions: string | undefined): boolean {
  if (!isPlainRecord(value)) return false;
  if (value['kind'] === 'continue') return hasExactKeys(value, ['kind']);
  if (value['kind'] === 'fork-from-baseline') {
    return (
      hasExactKeys(value, ['kind', 'throughRun']) &&
      passes(() => validateConversationPolicy(value, instructions))
    );
  }
  return (
    value['kind'] === 'fresh-from-artifact' &&
    hasExactKeys(value, ['kind', 'artifact']) &&
    freshAttemptHandoffArtifactSchema.safeParse(value['artifact']).success &&
    passes(() => validateConversationPolicy(value, instructions))
  );
}

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'goalRunId',
  'workflowId',
  'revision',
  'transitionSeq',
  'identity',
  'objective',
  'validator',
  'requireDeterministicValidation',
  'validatorTimeoutMs',
  'conversationPolicy',
  'retryPolicy',
  'bounds',
  'principal',
  'status',
  'terminalReason',
  'failureDetail',
  'currentTransition',
  'attempts',
  'usage',
  'active',
  'cancellation',
  'controllerRestarts',
  'auditLog',
  'closedAt',
  'cleanedUpAt',
  'createdAt',
  'updatedAt',
];

function isTerminalPairing(value: PlainRecord): boolean {
  const status = value['status'] as GoalRunStatus;
  const reason = value['terminalReason'];
  if (!isTerminalGoalStatus(status)) {
    return (
      reason === undefined && value['closedAt'] === undefined && value['cleanedUpAt'] === undefined
    );
  }
  // Cleanup is the work a closure owes, so only a closed goal can have done it.
  if (value['cleanedUpAt'] !== undefined && value['closedAt'] === undefined) return false;
  return isGoalRunTerminalReason(reason) && TERMINAL_STATUS_BY_REASON[reason] === status;
}

const TERMINAL_EVENT_KIND: Readonly<Partial<Record<GoalRunStatus, string>>> = {
  succeeded: 'goal.succeeded',
  exhausted: 'goal.exhausted',
  failed: 'goal.failed',
  canceled: 'goal.canceled',
};

/** Each kind's place in a transition's events: started, then validated, then the terminal event. */
const TRANSITION_EVENT_RANK: Readonly<Record<string, number>> = {
  'goal.attempt.started': 0,
  'goal.attempt.validated': 1,
  'goal.succeeded': 2,
  'goal.exhausted': 2,
  'goal.failed': 2,
  'goal.canceled': 2,
};

const VALIDATOR_OUTCOME_KINDS: readonly string[] = [
  'pass',
  'fail',
  'error',
  'unavailable',
  'canceled',
  'indeterminate',
];

const hasAllKeys = (value: PlainRecord, required: readonly string[]): boolean =>
  required.every((key) => Object.hasOwn(value, key));

/** The validator error a `goal.failed` event names, exactly as the projection derives it. */
function expectedValidatorError(
  record: PlainRecord,
): { kind: string; code: string; message: string } | undefined {
  if (record['terminalReason'] !== 'validator-infrastructure-error') return undefined;
  const attempts = record['attempts'] as readonly DurableGoalAttempt[];
  const outcome = attempts.at(-1)?.validation?.outcome;
  if (outcome === undefined || (outcome.kind !== 'error' && outcome.kind !== 'unavailable')) {
    return undefined;
  }
  const { kind, code, message } = outcome.error;
  return { kind, code, message };
}

function isAttemptStartedPayload(record: PlainRecord, payload: PlainRecord): boolean {
  if (
    !hasAllKeys(payload, ['goalRunId', 'attemptId', 'attemptIndex', 'runId']) ||
    !hasExactKeys(payload, ['goalRunId', 'attemptId', 'attemptIndex', 'runId'])
  ) {
    return false;
  }
  const attempts = record['attempts'] as readonly DurableGoalAttempt[];
  const attempt = isNonNegativeInteger(payload['attemptIndex'])
    ? attempts[payload['attemptIndex']]
    : undefined;
  return (
    attempt !== undefined &&
    attempt.attemptId === payload['attemptId'] &&
    attempt.runId === payload['runId']
  );
}

function isAttemptValidatedPayload(record: PlainRecord, payload: PlainRecord): boolean {
  const keys = ['goalRunId', 'attemptId', 'validatorIdentity', 'outcomeKind', 'feedbackDigest'];
  if (!hasAllKeys(payload, keys.slice(0, 4)) || !hasExactKeys(payload, keys)) return false;
  const attempts = record['attempts'] as readonly DurableGoalAttempt[];
  const attempt = attempts.find((candidate) => candidate.attemptId === payload['attemptId']);
  const outcomeKind = payload['outcomeKind'];
  if (attempt === undefined || !isString(outcomeKind)) return false;
  if (!VALIDATOR_OUTCOME_KINDS.includes(outcomeKind)) return false;
  if (!isValidatorIdentity(payload['validatorIdentity'])) return false;
  const digest = payload['feedbackDigest'];
  const recorded = attempt.validation;
  // The event reports a verdict, and the projection emits one only for an
  // attempt whose verdict the same commit recorded, which no later write can
  // remove (`applyAttempt` refuses a patch that drops it). An attempt with no
  // recorded verdict, such as a run an operator aborted into a retry, has none
  // for an event to report: a validated event naming it was never projected.
  if (recorded === undefined) return false;
  // The recorded verdict is the one this event reports, whatever its kind.
  const identity = payload['validatorIdentity'];
  if (
    recorded.outcome.kind !== outcomeKind ||
    recorded.identity.name !== identity.name ||
    recorded.identity.version !== identity.version
  ) {
    return false;
  }
  if (outcomeKind !== 'fail') return digest === undefined;
  if (!isString(digest) || !/^[0-9a-f]{64}$/.test(digest)) return false;
  return recorded.outcome.kind === 'fail' && sha256HexSync(recorded.outcome.feedback) === digest;
}

function isTerminalPayload(record: PlainRecord, kind: string, payload: PlainRecord): boolean {
  if (
    !hasAllKeys(payload, ['goalRunId', 'terminalReason']) ||
    !hasExactKeys(payload, ['goalRunId', 'terminalReason', 'validatorError']) ||
    payload['terminalReason'] !== record['terminalReason']
  ) {
    return false;
  }
  const expected = kind === 'goal.failed' ? expectedValidatorError(record) : undefined;
  const named = payload['validatorError'];
  if (expected === undefined) return named === undefined;
  return (
    isPlainRecord(named) &&
    hasExactKeys(named, ['kind', 'code', 'message']) &&
    named['kind'] === expected.kind &&
    named['code'] === expected.code &&
    named['message'] === expected.message
  );
}

function isEventPayloadGenuine(record: PlainRecord, event: GoalAuditEvent): boolean {
  const payload = event.payload as PlainRecord;
  if (payload['goalRunId'] !== record['goalRunId']) return false;
  switch (event.kind) {
    case 'goal.attempt.started':
      return isAttemptStartedPayload(record, payload);
    case 'goal.attempt.validated':
      return isAttemptValidatedPayload(record, payload);
    default:
      return isTerminalPayload(record, event.kind, payload);
  }
}

/**
 * A transition's audit entry holds only the events that transition can imply,
 * in the order the projection derives them, under the dedupe key it derives,
 * about this goal's own attempts. Only the goal's latest transition is still
 * described by the record itself, so it must carry exactly the events that
 * transition implies, no more and no fewer; an earlier one can only be held to
 * what any transition could have produced (a terminal event never: a terminal
 * status has no outgoing edge).
 */
function isTransitionEntryGenuine(record: PlainRecord, entry: GoalAuditEntry): boolean {
  const goalRunId = record['goalRunId'] as string;
  const isLatest = entry.seq === record['transitionSeq'];
  let previousRank = -1;
  for (const event of entry.events) {
    const rank = TRANSITION_EVENT_RANK[event.kind];
    if (rank === undefined || rank <= previousRank) return false;
    previousRank = rank;
    if (event.dedupeKey !== `${goalRunId}:${entry.seq}`) return false;
    if (
      rank === 2 &&
      (!isLatest || event.kind !== TERMINAL_EVENT_KIND[record['status'] as GoalRunStatus])
    ) {
      return false;
    }
    if (!isEventPayloadGenuine(record, event)) return false;
  }
  if (!isLatest) return true;
  const transition = record['currentTransition'] as GoalTransitionRecord;
  const attempts = record['attempts'] as readonly DurableGoalAttempt[];
  const expected: string[] = [];
  if (transition.to === 'running' && attempts.length > 0) expected.push('goal.attempt.started');
  if (transition.from === 'evaluating' && attempts.at(-1)?.validation !== undefined) {
    expected.push('goal.attempt.validated');
  }
  if (record['terminalReason'] !== undefined) {
    const terminal = TERMINAL_EVENT_KIND[record['status'] as GoalRunStatus];
    if (terminal !== undefined) expected.push(terminal);
  }
  return (
    expected.length === entry.events.length &&
    expected.every((kind, index) => entry.events[index]?.kind === kind)
  );
}

/** A counted restart's entry holds the one `goal.recovered` event the restart implies. */
function isRestartEntryGenuine(
  record: PlainRecord,
  entry: GoalAuditEntry,
  ordinal: number,
): boolean {
  const goalRunId = record['goalRunId'] as string;
  const [event, ...rest] = entry.events;
  if (event === undefined || rest.length > 0 || event.kind !== 'goal.recovered') return false;
  if (event.dedupeKey !== `${goalRunId}:${entry.seq}:restart-${ordinal}`) return false;
  const payload = event.payload as PlainRecord;
  const keys = ['goalRunId', 'controllerRestarts', 'status', 'transitionSeq'];
  return (
    hasAllKeys(payload, keys) &&
    hasExactKeys(payload, keys) &&
    payload['goalRunId'] === goalRunId &&
    payload['controllerRestarts'] === ordinal &&
    payload['transitionSeq'] === entry.seq &&
    isGoalRunStatus(payload['status']) &&
    (entry.seq !== record['transitionSeq'] || payload['status'] === record['status'])
  );
}

/**
 * The log holds exactly one entry per committed transition (seq 1 through
 * `transitionSeq`, in order) and one per counted restart (1 through
 * `controllerRestarts`, in order), interleaved by commit order, never past
 * the cap.
 */
function isAuditLogConsistent(value: PlainRecord): boolean {
  const goalRunId = value['goalRunId'] as string;
  const log = value['auditLog'] as readonly GoalAuditEntry[];
  if (log.length > GOAL_AUDIT_LOG_MAXIMUM_ENTRIES) return false;
  let transitions = 0;
  let restarts = 0;
  let lastSeq = 0;
  for (const entry of log) {
    if (entry.seq < lastSeq) return false;
    lastSeq = entry.seq;
    if (entry.transitionId === goalRestartId(goalRunId, restarts + 1)) {
      if (entry.seq !== transitions) return false;
      restarts += 1;
      if (!isRestartEntryGenuine(value, entry, restarts)) return false;
    } else if (entry.transitionId === goalTransitionId(goalRunId, transitions + 1)) {
      if (entry.seq !== transitions + 1) return false;
      transitions += 1;
      if (!isTransitionEntryGenuine(value, entry)) return false;
    } else {
      return false;
    }
  }
  return transitions === value['transitionSeq'] && restarts === value['controllerRestarts'];
}

const isInFlight = (attempt: DurableGoalAttempt | undefined): attempt is DurableGoalAttempt =>
  attempt !== undefined && (attempt.status === 'running' || attempt.status === 'evaluating');

/**
 * The status, the attempts, and the active work describe one situation, so a
 * record that contradicts itself is corrupt rather than something recovery
 * could act on:
 *
 * - no attempt but the last is in flight;
 * - `pending`: no attempts and no active work;
 * - `running`: the last attempt is `running`, and the active work is that
 *   attempt's own run;
 * - `evaluating`: the last attempt is `evaluating`, and the active work is the
 *   validation of that attempt;
 * - `retrying`: a last attempt that ended without passing, no active work, and
 *   fewer attempts than the bound allows;
 * - a terminal status: no attempt in flight and no active work (the
 *   terminal reason's agreement with the status is {@link isTerminalPairing}).
 */
function isStatusRelationConsistent(value: PlainRecord): boolean {
  const status = value['status'] as GoalRunStatus;
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  const active = value['active'] as ActiveGoalWork | undefined;
  const last = attempts.at(-1);
  if (attempts.slice(0, -1).some((attempt) => isInFlight(attempt))) return false;
  switch (status) {
    case 'pending':
      return attempts.length === 0 && active === undefined;
    case 'running':
      return (
        last?.status === 'running' &&
        active?.kind === 'attempt' &&
        active.attemptId === last.attemptId &&
        active.runId === last.runId &&
        active.startedAt === last.startedAt
      );
    case 'evaluating':
      return (
        last?.status === 'evaluating' &&
        active?.kind === 'validation' &&
        active.attemptId === last.attemptId
      );
    case 'retrying':
      return (
        last !== undefined &&
        (last.status === 'failed' || last.status === 'aborted') &&
        active === undefined &&
        // A retry is a promise of another attempt, so it needs room for one. At
        // the bound the decision is `exhausted`; a record that says otherwise is
        // one a controller would open an attempt past the bound for.
        attempts.length < (value['bounds'] as GoalBudget).maximumAttempts
      );
    default:
      return active === undefined && !isInFlight(last);
  }
}

/**
 * Every id an attempt carries is the one this goal's builders produce for its
 * index and conversation policy. The decoder is the single gate for reads and
 * for every write (the store checks each next record with it), so an attempt
 * that names another goal's run, session, or decision can neither be stored nor
 * be believed once read: a controller, a canceller, or the forwarder would
 * otherwise act on a run that is not this goal's.
 */
function hasOwnDerivedIds(value: PlainRecord): boolean {
  const goalRunId = value['goalRunId'] as string;
  const kind = (value['conversationPolicy'] as GoalConversationPolicy).kind;
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  return attempts.every(
    (attempt, index) =>
      attempt.attemptId === goalAttemptId(goalRunId, index) &&
      attempt.runId === goalAttemptRunId(goalRunId, index) &&
      attempt.sessionId === attemptSessionId(goalRunId, kind, index) &&
      (attempt.validation === undefined ||
        attempt.validation.decisionId === goalDecisionId(attempt.attemptId)),
  );
}

/**
 * The aggregate usage is the sum of what the recorded attempts reported, taken
 * in order, which is exactly how every transition builds it (the in-flight
 * attempt reports nothing until its run ends). A record whose aggregate says
 * otherwise is one a controller would trust instead of the attempts, so a goal
 * that really spent 50 steps could resume with none counted against
 * `maximumTotalSteps`. The cost is absent until some attempt reports one.
 * `durationMs` is a reading of the clock rather than a sum, so it has no
 * counterpart here.
 */
function isUsageConsistent(value: PlainRecord): boolean {
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  const usage = value['usage'] as DurableGoalUsage;
  let steps = 0;
  let tokens = 0;
  let costUsd: number | undefined;
  for (const attempt of attempts) {
    steps += attempt.usage.steps;
    tokens += attempt.usage.tokens;
    if (attempt.usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + attempt.usage.costUsd;
  }
  return (
    usage.attempts === attempts.length &&
    usage.steps === steps &&
    usage.tokens === tokens &&
    usage.costUsd === costUsd
  );
}

/** The status an attempt closes with for a validator's outcome, as the controller commits it. */
const attemptStatusForOutcome = (
  kind: ProjectedValidatorOutcome['kind'],
): DurableGoalAttemptStatus =>
  kind === 'pass' ? 'passed' : kind === 'canceled' ? 'aborted' : 'failed';

/**
 * An attempt's status and its validation say one thing. A validated attempt
 * carries exactly the status its outcome produces (`pass` is `passed`, `canceled`
 * is `aborted`, any other outcome is `failed`), and an attempt that was never
 * validated cannot have `passed`.
 */
function areAttemptOutcomesConsistent(value: PlainRecord): boolean {
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  return attempts.every((attempt) =>
    attempt.validation === undefined
      ? attempt.status !== 'passed'
      : attempt.status === attemptStatusForOutcome(attempt.validation.outcome.kind),
  );
}

/**
 * A terminal status and reason agree with what the goal's attempts show, since
 * the controller commits a terminal reason together with the attempt that earned
 * it:
 *
 * - `succeeded` (`validator-passed`): the last attempt passed its validation, and
 *   no other terminal status has an attempt that passed;
 * - `validator-fail-non-retryable`: the last attempt's validation failed;
 * - `validator-infrastructure-error`: the last attempt's validation ended in an
 *   error, unavailable, canceled, or indeterminate outcome, never in a verdict;
 * - `attempt-limit-reached`: as many attempts were made as the goal allows.
 *
 * The other reasons (`aggregate-budget-exceeded`, `attempt-run-failed`,
 * `unsupported-validation`, `goal-canceled`) end a goal with or without a verdict
 * on its last attempt, so no further agreement is required of them.
 */
function isTerminalOutcomeConsistent(value: PlainRecord): boolean {
  const status = value['status'] as GoalRunStatus;
  if (!isTerminalGoalStatus(status)) return true;
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  const last = attempts.at(-1);
  const verdict = last?.validation?.outcome.kind;
  if (status === 'succeeded') return last?.status === 'passed' && verdict === 'pass';
  if (attempts.some((attempt) => attempt.status === 'passed')) return false;
  switch (value['terminalReason']) {
    case 'validator-fail-non-retryable':
      return verdict === 'fail';
    case 'validator-infrastructure-error':
      return verdict !== undefined && verdict !== 'pass' && verdict !== 'fail';
    case 'attempt-limit-reached':
      return attempts.length >= (value['bounds'] as GoalBudget).maximumAttempts;
    default:
      return true;
  }
}

/**
 * A goal ends `canceled` exactly when a cancellation was asked for. The store
 * accepts only the transition to `canceled` once a marker is present, and
 * nothing commits `canceled` (recovery writes the marker first) without one, so
 * a terminal `canceled` record with no marker, or a terminal record of any other
 * status carrying one, was not written by this code. A goal that is not yet
 * terminal may hold a marker the controller has not acted on.
 */
function isCancellationConsistent(value: PlainRecord): boolean {
  const status = value['status'] as GoalRunStatus;
  if (!isTerminalGoalStatus(status)) return true;
  return (status === 'canceled') === (value['cancellation'] !== undefined);
}

function isConsistent(value: PlainRecord): boolean {
  const transition = value['currentTransition'] as GoalTransitionRecord;
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  return (
    isAuditLogConsistent(value) &&
    value['workflowId'] === goalWorkflowId(value['goalRunId'] as string) &&
    transition.seq === value['transitionSeq'] &&
    transition.to === value['status'] &&
    transition.transitionId === goalTransitionId(value['goalRunId'] as string, transition.seq) &&
    attempts.every((attempt, index) => attempt.attemptIndex === index) &&
    hasOwnDerivedIds(value) &&
    isUsageConsistent(value) &&
    isStatusRelationConsistent(value) &&
    isTerminalPairing(value) &&
    areAttemptOutcomesConsistent(value) &&
    isTerminalOutcomeConsistent(value) &&
    isCancellationConsistent(value)
  );
}

function isShape(value: PlainRecord): boolean {
  return (
    value['schemaVersion'] === GOAL_STATE_SCHEMA_VERSION &&
    isNonEmptyString(value['goalRunId']) &&
    value['goalRunId'].isWellFormed() &&
    isNonEmptyString(value['workflowId']) &&
    typeof value['revision'] === 'number' &&
    Number.isInteger(value['revision']) &&
    value['revision'] >= 1 &&
    isNonNegativeInteger(value['transitionSeq']) &&
    isIdentity(value['identity']) &&
    isObjective(value['objective']) &&
    isValidatorIdentity(value['validator']) &&
    typeof value['requireDeterministicValidation'] === 'boolean' &&
    (value['validatorTimeoutMs'] === undefined ||
      (isNonNegativeNumber(value['validatorTimeoutMs']) && value['validatorTimeoutMs'] > 0)) &&
    isConversationPolicy(value['conversationPolicy'], value['objective'].instructions) &&
    (value['retryPolicy'] === undefined || isRetryPolicy(value['retryPolicy'])) &&
    isBounds(value['bounds']) &&
    isOptionalString(value['principal']) &&
    isGoalRunStatus(value['status']) &&
    (value['terminalReason'] === undefined || isGoalRunTerminalReason(value['terminalReason'])) &&
    isOptionalString(value['failureDetail']) &&
    isTransitionRecord(value['currentTransition']) &&
    Array.isArray(value['attempts']) &&
    value['attempts'].every(isDurableGoalAttempt) &&
    isUsage(value['usage']) &&
    (value['active'] === undefined || isActiveWork(value['active'])) &&
    (value['cancellation'] === undefined || isCancellationMarker(value['cancellation'])) &&
    isNonNegativeInteger(value['controllerRestarts']) &&
    Array.isArray(value['auditLog']) &&
    value['auditLog'].every(isAuditEntry) &&
    isOptionalTimestamp(value['closedAt']) &&
    isOptionalTimestamp(value['cleanedUpAt']) &&
    isTimestamp(value['createdAt']) &&
    isTimestamp(value['updatedAt'])
  );
}

/** The fail-closed decoder: `true` only for a record of exactly this shape and internal consistency. */
export function isGoalState(value: unknown): value is GoalState {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, TOP_LEVEL_KEYS) &&
    isShape(value) &&
    isConsistent(value)
  );
}

/** Parses stored text; `undefined` for anything that is not a well-formed `GoalState`. */
export function decodeGoalState(text: string): GoalState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return isGoalState(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateGoalStateInput {
  readonly goalRunId: string;
  readonly identity: GoalIdentity;
  readonly objective: GoalObjective;
  readonly validator: ValidatorIdentity;
  readonly requireDeterministicValidation?: boolean | undefined;
  readonly validatorTimeoutMs?: number | undefined;
  readonly conversationPolicy: GoalConversationPolicy;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly bounds: GoalBudget;
  readonly principal?: string | undefined;
  /** ISO-8601, from Bureau's runtime clock. */
  readonly now: string;
}

/** Weft refuses a signal id over this many bytes and a workflow id over this many characters. */
const WEFT_IDENTIFIER_LIMIT = 128;
const identifierEncoder = new TextEncoder();

/**
 * A goal's id names its controller workflow (`goal:<id>`), each attempt's run
 * (`goal-<id>-a<n>`), and the signals sent to the controller
 * (`attempt-terminal:<id>:<n>`, `cancel:<id>`). Weft refuses any of them past
 * its limit, and a refused signal never arrives: the goal would park forever.
 * So the id is checked against every one of them, at the last attempt the
 * goal's own bound allows, before anything is written.
 */
function validateGoalRunId(goalRunId: string, maximumAttempts: number): void {
  if (goalRunId.length === 0) {
    throw new GoalRunIdError('empty', 'The goal id must not be empty.');
  }
  // eslint-disable-next-line no-control-regex -- Weft's own workflow-id rule is exactly these.
  if (/[\u0000-\u001f\u007f]/.test(goalRunId)) {
    throw new GoalRunIdError(
      'control-character',
      'The goal id must not contain control characters.',
    );
  }
  // A lone surrogate cannot be encoded (the record key is percent-encoded), so
  // it would surface as a URIError from the store instead of this rejection.
  if (!goalRunId.isWellFormed()) {
    throw new GoalRunIdError('malformed', 'The goal id must be well-formed Unicode text.');
  }
  const last = Math.max(0, maximumAttempts - 1);
  const signals = [attemptSignalId(goalRunId, last), cancelSignalId(goalRunId)];
  const workflows = [goalWorkflowId(goalRunId), goalAttemptRunId(goalRunId, last)];
  if (
    signals.some((id) => identifierEncoder.encode(id).byteLength > WEFT_IDENTIFIER_LIMIT) ||
    workflows.some((id) => id.length > WEFT_IDENTIFIER_LIMIT)
  ) {
    throw new GoalRunIdError(
      'too-long',
      `The goal id is too long: the identifiers derived from it must fit Weft's ${WEFT_IDENTIFIER_LIMIT}-byte limit.`,
    );
  }
}

/**
 * Every invariant the record decoder holds a stored goal to that no other
 * create-time check already enforces (the budget, retry policy, conversation
 * policy, objective size, and goal id are checked by their own validators), so
 * a request the decoder would refuse is refused here, by name, instead of
 * surfacing as a generic decode failure or an exception:
 *
 * - `identity` and `validator`: exactly `name` and `version`, both non-empty text.
 * - `objective`: a non-empty `agentName`, text `prompt`, text or absent `instructions`.
 * - `requireDeterministicValidation`: a boolean, or absent.
 * - `validatorTimeoutMs`: a finite number above zero, or absent.
 * - `principal`: text or absent.
 * - `bounds`, `retryPolicy`, and `conversationPolicy`: no keys the record does not hold.
 * - `now`: non-empty text.
 */
export function describeCreateDefect(input: CreateGoalStateInput): string | undefined {
  const named = (value: unknown): boolean =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['name', 'version']) &&
    isNonEmptyString(value['name']) &&
    isNonEmptyString(value['version']);
  if (!named(input.identity)) {
    return 'The goal identity must be exactly a non-empty name and version.';
  }
  if (!named(input.validator)) {
    return 'The goal validator must be exactly a non-empty name and version.';
  }
  const objective = input.objective as unknown;
  if (
    !isPlainRecord(objective) ||
    !hasExactKeys(objective, ['agentName', 'prompt', 'instructions']) ||
    !isNonEmptyString(objective['agentName']) ||
    !isString(objective['prompt']) ||
    !isOptionalString(objective['instructions'])
  ) {
    return 'The goal objective must be a non-empty agent name, a text prompt, and optional text instructions.';
  }
  if (
    input.requireDeterministicValidation !== undefined &&
    typeof input.requireDeterministicValidation !== 'boolean'
  ) {
    return 'requireDeterministicValidation must be a boolean.';
  }
  if (
    input.validatorTimeoutMs !== undefined &&
    !(isNonNegativeNumber(input.validatorTimeoutMs) && input.validatorTimeoutMs > 0)
  ) {
    return `validatorTimeoutMs must be a finite number above zero; got ${String(input.validatorTimeoutMs)}.`;
  }
  if (!isOptionalString(input.principal)) return 'The goal principal must be text.';
  if (!isNonEmptyString(input.now)) return 'The creation time must be non-empty text.';
  const exact = (value: unknown, keys: readonly string[]): boolean =>
    value === undefined || (isPlainRecord(value) && hasExactKeys(value, keys));
  if (!exact(input.bounds, BOUNDS_KEYS)) {
    return `The goal budget must hold only ${BOUNDS_KEYS.join(', ')}.`;
  }
  if (!exact(input.retryPolicy, ['retryOn'])) return 'The retry policy must hold only retryOn.';
  const policy = input.conversationPolicy as unknown;
  if (isPlainRecord(policy)) {
    const keys =
      policy['kind'] === 'fork-from-baseline'
        ? ['kind', 'throughRun']
        : policy['kind'] === 'fresh-from-artifact'
          ? ['kind', 'artifact']
          : ['kind'];
    if (!hasExactKeys(policy, keys)) {
      return `A ${String(policy['kind'])} conversation policy must hold only ${keys.join(', ')}.`;
    }
  }
  return undefined;
}

const zeroUsage: DurableGoalUsage = { attempts: 0, steps: 0, tokens: 0, durationMs: 0 };

/**
 * Builds the initial `pending` record: revision 1, transition 0. Validates
 * with COR-638's own rules and the objective cap, so an unusable goal is
 * refused before any record is written. Throws `GoalConfigurationError` for a
 * rejected budget, retry policy, or conversation policy,
 * `GoalObjectiveTooLargeError` for an oversized objective, and
 * `InvalidGoalStateError` for any other shape defect.
 */
export function createGoalState(input: CreateGoalStateInput): GoalState {
  validateBudget(input.bounds);
  if (input.bounds.maximumAttempts > GOAL_MAXIMUM_ATTEMPTS) {
    throw new GoalConfigurationError(
      'invalid-maximum-attempts',
      `GoalBudget.maximumAttempts must be at most ${GOAL_MAXIMUM_ATTEMPTS} for a durable goal, so its audit log stays bounded.`,
    );
  }
  validateGoalRunId(input.goalRunId, input.bounds.maximumAttempts);
  validateRetryPolicy(input.retryPolicy);
  validateConversationPolicy(input.conversationPolicy, input.objective.instructions);
  const defect = describeCreateDefect(input);
  if (defect !== undefined) throw new InvalidGoalStateError(defect);
  const objectiveBytes = objectiveByteLength(input.objective);
  if (objectiveBytes > GOAL_OBJECTIVE_MAXIMUM_BYTES) {
    throw new GoalObjectiveTooLargeError(objectiveBytes);
  }
  const state = JSON.parse(
    JSON.stringify({
      schemaVersion: GOAL_STATE_SCHEMA_VERSION,
      goalRunId: input.goalRunId,
      workflowId: goalWorkflowId(input.goalRunId),
      revision: 1,
      transitionSeq: 0,
      identity: input.identity,
      objective: input.objective,
      validator: input.validator,
      requireDeterministicValidation: input.requireDeterministicValidation ?? false,
      validatorTimeoutMs: input.validatorTimeoutMs,
      conversationPolicy: input.conversationPolicy,
      retryPolicy: input.retryPolicy,
      bounds: input.bounds,
      principal: input.principal,
      status: 'pending',
      currentTransition: {
        seq: 0,
        transitionId: goalTransitionId(input.goalRunId, 0),
        from: 'pending',
        to: 'pending',
        at: input.now,
        cause: 'created',
      },
      attempts: [],
      usage: zeroUsage,
      controllerRestarts: 0,
      auditLog: [],
      createdAt: input.now,
      updatedAt: input.now,
    }),
  ) as unknown;
  if (!isGoalState(state)) {
    throw new InvalidGoalStateError(
      `Bureau goal "${input.goalRunId}" does not describe a valid goal record.`,
    );
  }
  return state;
}
