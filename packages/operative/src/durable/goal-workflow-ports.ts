/**
 * COR-851 — the plain-data contract between the durable `goalRun` workflow and
 * the host (Bureau) that owns its storage.
 *
 * The workflow never holds a closure, a store, a clock, or a validator. Everything
 * it needs from the outside world crosses {@link GoalWorkflowPorts}, and every
 * value that crosses is plain JSON-safe data, so a recorded activity result can
 * be replayed byte for byte.
 *
 * Operative cannot import Bureau, so the record the workflow reads is a narrow
 * structural view ({@link GoalWorkflowRecord}). Bureau's `GoalState` is
 * assignable to it, and Bureau's `GoalTransitionRequest` is assignable from
 * {@link GoalWorkflowTransition}; the field names are deliberately identical.
 */

import type {
  GoalBudget,
  GoalRetryPolicy,
  GoalRunStatus,
  GoalRunTerminalReason,
  ProjectedValidatorOutcome,
  ProjectedValidatorResult,
  ValidatorIdentity,
} from '../goal-decision';
import type { FinishReason } from '../types';

/** The registered workflow type, and the key `createRunEngine` registers it under. */
export const GOAL_WORKFLOW_TYPE = 'goalRun' as const;

/** The control-plane cancel signal. An optimisation only: the record's marker is authoritative. */
export const GOAL_CANCEL_SIGNAL = 'cancel' as const;

/**
 * One signal name per attempt, so a late re-send for attempt 0 can never wake
 * attempt 1. Send it with a stable `signalId` so a recovery pass can re-send it
 * idempotently.
 */
export const goalAttemptTerminalSignalName = (attemptIndex: number): string =>
  `attempt-terminal:${attemptIndex}`;

export interface GoalWorkflowInput {
  readonly goalRunId: string;
}

/**
 * The payload of `attempt-terminal:<n>`: everything the controller needs to
 * decide what the finished attempt means. It rides the signal rather than a
 * port read so the decision is a pure function of recorded data.
 */
export interface GoalAttemptTerminalSignal {
  readonly finishReason: FinishReason;
  readonly steps: number;
  readonly tokens: number;
  /** Absent when the finished run reported no `costEstimate`. */
  readonly costUsd?: number | undefined;
}

// ---------------------------------------------------------------------------
// The record, as the workflow sees it
// ---------------------------------------------------------------------------

export type GoalWorkflowAttemptStatus = 'running' | 'evaluating' | 'passed' | 'failed' | 'aborted';

export interface GoalWorkflowValidation {
  readonly identity: ValidatorIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ProjectedValidatorOutcome;
  readonly decisionId: string;
}

export interface GoalWorkflowAttemptUsage {
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
}

export interface GoalWorkflowAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly runId: string;
  /** What `startAttempt` answered: the session the attempt's run is recorded in, which the port decides. */
  readonly sessionId: string;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly validation?: GoalWorkflowValidation | undefined;
  readonly feedback?: string | undefined;
  readonly usage: GoalWorkflowAttemptUsage;
  readonly status: GoalWorkflowAttemptStatus;
}

export interface GoalWorkflowUsage {
  readonly attempts: number;
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  readonly durationMs: number;
}

export type GoalWorkflowActiveWork =
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

/** What the controller reads from a goal's durable record. Bureau's `GoalState` satisfies it. */
export interface GoalWorkflowRecord {
  readonly goalRunId: string;
  readonly status: GoalRunStatus;
  /** Advances only on a controller transition; the next one commits `transitionSeq + 1`. */
  readonly transitionSeq: number;
  readonly validator: ValidatorIdentity;
  readonly validatorTimeoutMs?: number | undefined;
  readonly bounds: GoalBudget;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly attempts: readonly GoalWorkflowAttempt[];
  readonly usage: GoalWorkflowUsage;
  readonly active?: GoalWorkflowActiveWork | undefined;
  /** Authoritative: present once an operator asked this goal to stop. */
  readonly cancellation?: { readonly requestedAt: string } | undefined;
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  /** ISO-8601. The aggregate duration bound is measured from here. */
  readonly createdAt: string;
}

/**
 * The record trimmed to what a decision reads. Validation outcomes can hold
 * tens of kilobytes of evidence per attempt and every load is cached in the
 * workflow's history, so the view leaves them out: a decision never reads a
 * recorded outcome, and the one an attempt is about to get is produced fresh.
 */
export interface GoalWorkflowView extends Omit<GoalWorkflowRecord, 'attempts'> {
  readonly attempts: readonly Omit<GoalWorkflowAttempt, 'validation'>[];
}

// ---------------------------------------------------------------------------
// Port requests and results
// ---------------------------------------------------------------------------

export interface GoalWorkflowLoad {
  /** `undefined` when the record is missing or unreadable. */
  readonly record: GoalWorkflowRecord | undefined;
  /** Epoch milliseconds from the host's clock. The workflow reads time nowhere else. */
  readonly nowMs: number;
}

export interface GoalWorkflowTransition {
  readonly goalRunId: string;
  /** The `transitionSeq` this commit produces. */
  readonly seq: number;
  /** Stable across replays; derived from `seq` by {@link GoalWorkflowIdentifiers}. */
  readonly transitionId: string;
  readonly to: GoalRunStatus;
  /** ISO-8601, derived from the clock reading the decision was made on. */
  readonly at: string;
  readonly cause: string;
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  /** Inserts at `attempts.length` or replaces the attempt at its own index. */
  readonly attempt?: GoalWorkflowAttempt | undefined;
  readonly usage?: GoalWorkflowUsage | undefined;
  /** `null` clears the in-flight work; omitted keeps it. */
  readonly active?: GoalWorkflowActiveWork | null | undefined;
}

export type GoalWorkflowRejection =
  | 'terminal'
  | 'illegal-transition'
  | 'cancellation-requested'
  | 'invalid-terminal-reason'
  | 'invalid-attempt'
  | 'decision-already-recorded'
  | 'oversized'
  | 'invalid-record';

/**
 * What the store said, minus the record: the controller always re-reads at its
 * next decision point, so carrying the record here would only bloat history.
 */
export type GoalWorkflowCommit =
  | { readonly status: 'applied' | 'duplicate' | 'stale' }
  | { readonly status: 'rejected'; readonly reason: GoalWorkflowRejection }
  | { readonly status: 'missing' | 'corrupt' };

export interface GoalWorkflowStartRequest {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly attemptId: string;
  /** Deterministic: attempt N always runs as the same run id. */
  readonly runId: string;
  /** The feedback this attempt's input carries; absent for the first attempt. */
  readonly feedback?: string | undefined;
}

/**
 * Start-or-adopt. A run that already exists under `runId` is adopted, and a
 * claim recorded without a started run (a crash between the two) is completed
 * from the claim. `failed` carries the `failureDetail` the goal ends with.
 */
export type GoalWorkflowStart =
  | { readonly status: 'started' | 'adopted'; readonly sessionId: string }
  | { readonly status: 'failed'; readonly detail: string }
  /**
   * The start created nothing, because the goal was canceled, had ended, or its
   * aggregate duration had elapsed before the start wrote anything (or the goal
   * was canceled or ended while the run was being started, in which case the
   * port stopped the run it had created). It is not a verdict on the attempt:
   * the controller commits nothing, and its next read of the record ends the
   * goal the way the record says.
   */
  | { readonly status: 'stood-down' };

export interface GoalWorkflowValidatorRequest {
  readonly goalRunId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly validator: ValidatorIdentity;
  readonly validatorTimeoutMs?: number | undefined;
}

export interface GoalWorkflowAbortRequest {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly attemptId: string;
  readonly runId: string;
}

/** The deterministic names. Bureau supplies the same helpers its records are keyed by. */
export interface GoalWorkflowIdentifiers {
  transitionId(goalRunId: string, seq: number): string;
  attemptId(goalRunId: string, attemptIndex: number): string;
  attemptRunId(goalRunId: string, attemptIndex: number): string;
  decisionId(attemptId: string): string;
}

/**
 * Every effect the goal controller has on the world. Each method runs inside a
 * Weft activity, so each may run more than once and must be idempotent.
 */
export interface GoalWorkflowPorts {
  readonly identifiers: GoalWorkflowIdentifiers;
  /** A fresh read of the record, with the host clock. Never throws for a missing record. */
  loadGoalState(goalRunId: string): Promise<GoalWorkflowLoad>;
  /** One compare-and-swap transition; see Bureau's `GoalStore.applyTransition`. */
  commitTransition(request: GoalWorkflowTransition): Promise<GoalWorkflowCommit>;
  /**
   * Start-or-adopt the attempt's run. `signal` is the activity's own: Weft aborts
   * it when a try times out, and that try goes on running in the background
   * after the retry that replaced it has started. A port that sees it aborted
   * must write nothing further and must stop any run its own try created.
   */
  startAttempt(request: GoalWorkflowStartRequest, signal?: AbortSignal): Promise<GoalWorkflowStart>;
  /**
   * Runs the catalogued validator, normalizes and projects its output, and
   * bounds it to the inline cap. A throwing or malformed validator is an
   * `error` outcome here, never a throw: the controller treats a throw as a
   * controller failure, not a verdict. `signal` is the activity's own: Weft
   * aborts it when the controller is cancelled or the try times out, and it is
   * composed into the validator's own signal so a validator that honors it stops
   * instead of running on for a goal that is over (the verdict then reads as
   * `canceled`, and is discarded by a controller that has been cancelled).
   */
  runValidator(
    request: GoalWorkflowValidatorRequest,
    signal?: AbortSignal,
  ): Promise<ProjectedValidatorResult>;
  /** Stops the attempt's run. A no-op when the run was never started or already ended. */
  abortAttempt(request: GoalWorkflowAbortRequest): Promise<void>;
}

// ---------------------------------------------------------------------------
// The workflow's result
// ---------------------------------------------------------------------------

export const GOAL_WORKFLOW_RESULT_SCHEMA_VERSION = 1 as const;

export type GoalWorkflowResult =
  | {
      readonly schemaVersion: typeof GOAL_WORKFLOW_RESULT_SCHEMA_VERSION;
      readonly outcome: 'terminal';
      readonly goalRunId: string;
      readonly status: 'succeeded' | 'exhausted' | 'failed' | 'canceled';
      readonly terminalReason: GoalRunTerminalReason;
      readonly failureDetail?: string | undefined;
      readonly transitionSeq: number;
    }
  | {
      readonly schemaVersion: typeof GOAL_WORKFLOW_RESULT_SCHEMA_VERSION;
      readonly outcome: 'record-unavailable';
      readonly goalRunId: string;
    };

/** The controller hit a state it cannot reason about; the workflow fails so recovery can restart it. */
export class GoalControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalControllerError';
  }
}
