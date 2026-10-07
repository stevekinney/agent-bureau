/**
 * COR-851 — the public contract of `bureau.goals`, and the narrow engine view
 * its implementation files share.
 *
 * A Bureau goal is durable: its record (`GoalState`) lives in Bureau's key-value
 * store, its controller is a Weft workflow, and each attempt is a durable
 * catalog run. `bureau.goals` is the control plane over that record. Every
 * method resolves rather than throws for an outcome a caller can act on, and a
 * principal that does not own a goal reads exactly as a goal that does not
 * exist.
 */

import type {
  CleanupAcknowledgement,
  GoalBudget,
  GoalConversationPolicy,
  GoalIdentity,
  GoalRetryPolicy,
  GoalRunStatus,
  ValidatorIdentity,
} from '@lostgradient/operative';
import type { RegistryAgnosticEngine } from '@lostgradient/weft';

import type { GoalState } from './goal-state';

/** The slice of the durable engine the goal control plane drives. */
export type GoalEngine = Pick<
  RegistryAgnosticEngine,
  'get' | 'start' | 'signal' | 'cancel' | 'resume' | 'getHandle' | 'getFinalizerStatus'
>;

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface BureauGoalRequest<TName extends string = string> {
  /** The catalog agent that runs each attempt. It must be able to run durably. */
  readonly agentName: TName;
  readonly prompt: string;
  /** Stored with the objective. The `fresh-from-artifact` policy seeds each fresh conversation with it, and requires it. */
  readonly instructions?: string | undefined;
  readonly identity: GoalIdentity;
  /** Resolved from `BureauOptions.validators` by exact name and version. */
  readonly validator: ValidatorIdentity;
  readonly bounds: GoalBudget;
  /**
   * Defaults to `{ kind: 'continue' }`. Each policy keeps the goal's
   * conversation in the bureau's session store, so it survives a restart:
   *
   * - `continue`: every attempt runs in one session, and a retry's turn is the
   *   validator's feedback appended to the transcript.
   * - `fork-from-baseline`: attempt 0 runs in the goal's session and every retry
   *   runs in a fork of it through `throughRun`. A goal has no session before
   *   its first attempt, so the run a retry can fork through is run 0 and
   *   `create` rejects any other `throughRun` as `invalid-configuration`.
   * - `fresh-from-artifact`: every retry starts a new conversation from
   *   `instructions` and the validated handoff artifact, with no transcript.
   */
  readonly conversationPolicy?: GoalConversationPolicy | undefined;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly validatorTimeoutMs?: number | undefined;
  readonly requireDeterministicValidation?: boolean | undefined;
  /** The principal that owns the goal; every later call is checked against it. */
  readonly principal?: string | undefined;
  /**
   * Makes `create` idempotent: the same request under the same id answers
   * `existing`, a different one answers `conflict`. Minted when omitted.
   */
  readonly goalRunId?: string | undefined;
}

export type BureauGoalCreateRejectionCode =
  /** No durable engine: a goal that could not survive a restart is never created. */
  | 'durable-unavailable'
  | 'shutdown'
  | 'agent-not-found'
  /** The agent has no durable resolver, so an attempt could not be recovered. */
  | 'agent-not-durable'
  | 'validator-missing'
  | 'validator-version-mismatch'
  /**
   * COR-638's budget, retry-policy, or conversation-policy rules refused the
   * request, or a `fresh-from-artifact` artifact failed COR-894's validation
   * (including that `BureauOptions.resolveFreshAttemptSource` cannot vouch for it).
   */
  | 'invalid-configuration'
  /**
   * The goal id cannot name the workflows and signals a goal is made of: it is
   * empty, it has a control character or a lone surrogate, or an identifier derived from it
   * would pass Weft's 128-byte limit (an over-long signal id is never delivered, so the goal
   * would wait forever).
   */
  | 'invalid-goal-run-id'
  | 'objective-too-large'
  /** The record stored under this id cannot be read. */
  | 'record-unreadable';

/** How the goal's controller workflow stood once `create` returned. */
export type BureauGoalControllerStart =
  | { readonly status: 'started' }
  /** The record exists but its workflow did not start; `recover()` starts it. */
  | { readonly status: 'start-failed'; readonly reason: string }
  /** The goal ended (at creation as `unsupported-validation`, or by a cancel or close since), or a cancellation is recorded, so there is no controller to start. */
  | { readonly status: 'not-needed' };

export type BureauGoalCreateOutcome =
  | {
      readonly outcome: 'created';
      readonly goal: GoalState;
      readonly controller: BureauGoalControllerStart;
    }
  /**
   * The id already names this exact request. Nothing was written, but a goal
   * that is not terminal is made sure to have its controller (a create that
   * died between recording the goal and starting it is healed by repeating
   * it); `controller` says how that stood.
   */
  | {
      readonly outcome: 'existing';
      readonly goal: GoalState;
      readonly controller?: BureauGoalControllerStart | undefined;
    }
  /**
   * The id already names a different request. Nothing was written. `goal` is
   * present only for a caller who may read that goal: a different principal's
   * request learns that the id is taken and nothing else.
   */
  | { readonly outcome: 'conflict'; readonly goal?: GoalState | undefined }
  | {
      readonly outcome: 'rejected';
      readonly code: BureauGoalCreateRejectionCode;
      readonly reason: string;
      /** For `validator-version-mismatch`: the versions that are registered. */
      readonly availableVersions?: readonly string[];
    };

// ---------------------------------------------------------------------------
// get, list, active, close
// ---------------------------------------------------------------------------

export interface BureauGoalQuery {
  /** Omitted is a trusted, internal call. */
  readonly principal?: string | undefined;
}

export interface BureauGoalListOptions extends BureauGoalQuery {
  readonly status?: GoalRunStatus | readonly GoalRunStatus[] | undefined;
}

/** The work a goal has in flight right now. */
export type BureauGoalActiveWork =
  | {
      readonly kind: 'attempt';
      readonly attemptId: string;
      readonly attemptIndex: number;
      /** The durable run that is the attempt; inspect it with `getDurableRun`. */
      readonly runId: string;
      readonly startedAt: string;
      /** The run's own workflow status, read now; `null` when it has no workflow. */
      readonly runStatus: string | null;
      /**
       * Set when reading the run failed, or when the bureau has no durable engine
       * to read it with. `runStatus` is then `null` too, but that does not mean the
       * run has no workflow; this says why it could not be read.
       */
      readonly runStatusError?: string | undefined;
    }
  | {
      readonly kind: 'validation';
      readonly attemptId: string;
      readonly attemptIndex: number;
      readonly validator: ValidatorIdentity;
      readonly startedAt: string;
    };

export type BureauGoalCloseOutcome =
  /**
   * `closedAt` is set. The goal record and its workflow stay inspectable.
   * `cleanup` is the truthful result of applying the bureau's checkpoint
   * retention to the history of the controller workflow and of every attempt's
   * run, the least favorable of them: `not-required` when the policy keeps
   * everything or the goal never had a workflow, `completed` once pruned, and
   * `unresolved` or `failed` when any could not be, which `close()` again
   * retries. `cleanedUpAt` is set on the goal only once nothing is left owed, so a
   * closure whose cleanup was interrupted (a crash, an unreachable engine) is
   * finished by the next boot with no call. A bureau with no durable engine cannot look for a
   * controller, so it answers `unresolved` (`unreachable`), never `not-required`.
   */
  | {
      readonly outcome: 'closed';
      readonly goal: GoalState;
      readonly cleanup: CleanupAcknowledgement;
    }
  | { readonly outcome: 'not-terminal'; readonly goal: GoalState }
  /**
   * The goal is `canceled`, but a fresh read still finds something its
   * cancellation must stop unfinished (`awaiting`, as `cancel()` names it). A
   * closed goal leaves the boot sweep, so closing one before the world agrees
   * would leave a suspended controller, finalizer, or attempt run active with
   * nothing left to settle it. `closedAt` is not set; call again once it settles.
   */
  | {
      readonly outcome: 'cancellation-pending';
      readonly goal: GoalState;
      readonly awaiting: readonly BureauGoalCancellationWait[];
    }
  /**
   * The goal is `exhausted`, but a run its ending overtook (an attempt's start
   * the aggregate duration abandoned, which created its run afterwards) could
   * not be stopped (`detail`). A closed, cleaned goal leaves the boot sweep, so
   * closing one with that run alive would strand it. `closedAt` is not set; call
   * again once it can be stopped. It is also the answer for a closed goal whose
   * checkpoint cleanup finished but could not be recorded (`cleanedUpAt` is
   * unset), which the next `close()` or boot records.
   */
  | {
      readonly outcome: 'cleanup-pending';
      readonly goal: GoalState;
      readonly detail: string;
    }
  /** Lost the write to concurrent writers too many times in a row; call again. */
  | { readonly outcome: 'contended'; readonly goal: GoalState }
  /** A record is stored under this id but cannot be decoded: a permanent fault, not absence. */
  | { readonly outcome: 'record-unreadable' }
  | { readonly outcome: 'not-found' };

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface BureauGoalCancelOptions extends BureauGoalQuery {
  readonly reason?: string | undefined;
}

/** What `cancel()` could not yet read back as finished. */
export type BureauGoalCancellationWait =
  /** The goal record is not yet `canceled`. */
  | 'goal-record'
  /** The controller workflow has not reached a terminal status. */
  | 'controller'
  /** The controller's finalizer is pending or running, or its status could not be read. */
  | 'finalizer'
  /**
   * The controller's finalizer failed and the engine dead-lettered it, so it
   * will not be retried and waiting will not settle it. The goal is still
   * `canceled` and never reads as done: whatever the finalizer was to stop
   * (the active attempt's run) may be running and needs an operator.
   */
  | 'finalizer-failed'
  /** The in-flight attempt's run has not reached a terminal status. */
  | 'attempt-run'
  /**
   * This bureau has no durable engine, so it can neither stop nor even read the
   * controller, its finalizer, or the attempt's run. The goal's cancellation is
   * recorded, but nothing here can acknowledge that the workflow ended; a bureau
   * with an engine settles it (the boot sweep does, or `cancel()` again).
   */
  | 'durable-engine';

/**
 * What a `cancel()` outcome means. It is an answer about durable state read
 * back after the request, never about a request merely having been sent.
 *
 * - `canceled`: a fresh read, taken after `engine.cancel` settled and the
 *   attempt was stopped, found the goal record `canceled`, the controller
 *   workflow terminal, its finalizer `succeeded` or not owed (a controller that
 *   ended on its own staged nothing to finalize), and the in-flight attempt's
 *   run terminal or absent. Nothing else is answered `canceled`.
 * - `cancellation-pending`: the cancellation marker is durably recorded, so the
 *   goal will end `canceled` and no controller transition can overtake it, but
 *   the read-back found something in `awaiting` still unfinished. `finalizer`
 *   (pending, running, or unreadable), `controller`, `attempt-run`, and
 *   `goal-record` are in progress: call `recover()` or `cancel()` again; both
 *   are idempotent. `finalizer-failed` is different: the engine dead-lettered
 *   the finalizer and will not retry it, so repeating `cancel()` re-reads the
 *   same failure and it is also written to the diagnostics. It is reported
 *   rather than hidden, and is never answered `canceled`.
 * - `already-terminal`: the goal had already ended for a reason other than
 *   cancellation; nothing was changed. A goal that ended `canceled` is never
 *   answered this way: its controller and attempt run are stopped again and
 *   read back, so a retry after `cancellation-pending` finishes the job and
 *   answers `canceled` or `cancellation-pending` like the first call did.
 * - `contended`: the marker could not be written because concurrent writers
 *   won the compare-and-swap every time the store retried. Nothing was
 *   recorded and nothing will cancel the goal; call `cancel()` again.
 * - `not-found`: no such goal, or one this principal does not own.
 * - `record-unreadable`: a record is stored under the id but cannot be
 *   decoded. That is a fault to repair, not absence; nothing was changed.
 *
 * What `canceled` does not say: a validator that was executing when the goal
 * was canceled is not told to stop. Durable validation runs with a signal that
 * never aborts (a shutdown is a crash for the next process to recover, not a
 * verdict), so it runs to completion and its verdict is discarded, because the
 * record accepts no transition but `canceled` once the marker is set. A
 * validator with side effects must therefore tolerate being run to completion.
 */
export type BureauGoalCancelOutcome =
  | { readonly outcome: 'canceled'; readonly goal: GoalState }
  | {
      readonly outcome: 'cancellation-pending';
      readonly goal: GoalState;
      readonly awaiting: readonly BureauGoalCancellationWait[];
    }
  | { readonly outcome: 'already-terminal'; readonly goal: GoalState }
  | { readonly outcome: 'contended'; readonly goal: GoalState }
  /** A record is stored under this id but cannot be decoded: a permanent fault, not absence. */
  | { readonly outcome: 'record-unreadable' }
  | { readonly outcome: 'not-found' };

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

/**
 * What recovery did for one goal.
 *
 * - `started`: no controller workflow existed (a crash between writing the
 *   record and starting it), so one was started.
 * - `restarted`: the controller ended abnormally while the goal was not
 *   terminal, so a new one was started from the record and `controllerRestarts`
 *   advanced.
 * - `running`: a controller is alive, under this engine or another; recovery
 *   only reconciled the attempt behind it.
 * - `restart-pending`: the controller ended abnormally and its restart could not
 *   happen yet (its finalizer is still owed, its teardown is pending, or the
 *   finalizer could not be read). The goal has no controller, and nothing
 *   retries on its own: `recover()` again does. It is a failure in the boot
 *   report, not a clean boot.
 * - `canceled`: an operator's cancellation (or an engine-level cancel of the
 *   controller) was completed by committing `canceled`, and a fresh read found
 *   the controller and the attempt's run terminal.
 * - `cancellation-pending`: `canceled` was committed, but the read found the
 *   controller, its finalizer, or the attempt's run not yet terminal (see
 *   `detail`); `cancel()` or `recover()` again finishes it.
 * - `cleanup-pending`: the goal has ended, but something its ending still owed
 *   could not be finished by this recovery (stopping a run its ending overtook,
 *   or the checkpoint cleanup a closure owes, with a part that failed to prune,
 *   could not be reached, or no engine to prune with; see `detail`). Nothing
 *   retries on its own: the next boot, `recover()`, or `close()` does. It is a
 *   failure in the boot report, not a clean boot.
 * - `shutting-down`: the bureau has begun shutting down, so recovery started,
 *   resumed, and restarted nothing and spent no restart: a controller would be
 *   created on an engine that is being disposed. The goal is left as it is, and
 *   the next boot's recovery handles it. It is not a failure.
 * - `unsupported-validation`: the goal had not started, and its validator cannot
 *   supply the deterministic evidence it requires, so recovery ended it
 *   `failed`/`unsupported-validation` without starting a controller.
 * - `already-terminal`, `not-found`: nothing to do.
 * - `unrecoverable`: recovery gave up on the goal, which is left exactly as it
 *   is (no terminal reason is invented for it): its controller has already been
 *   restarted the maximum number of times, something else holds its workflow,
 *   its audit log has no room to record another restart, its stored record
 *   cannot be decoded, or the bureau has no durable engine to run a controller.
 */
export type BureauGoalRecoveryOutcome =
  | 'started'
  | 'restarted'
  | 'running'
  | 'restart-pending'
  | 'canceled'
  | 'cancellation-pending'
  | 'cleanup-pending'
  | 'shutting-down'
  | 'unsupported-validation'
  | 'already-terminal'
  | 'not-found'
  | 'unrecoverable';

/** What recovery did about the attempt a `running` goal was waiting on. */
export type BureauGoalAttemptRecovery =
  /** The attempt's run is alive; its terminal signal will be forwarded when it ends. */
  | 'watching'
  /** The attempt's run had already ended, so its terminal signal was sent again. */
  | 'signal-resent'
  /** The attempt's run never started, so it was started now. */
  | 'run-started'
  /** The attempt's run could not be reconciled; see `detail`. */
  | 'failed';

export interface BureauGoalRecoveryEntry {
  readonly goalRunId: string;
  readonly outcome: BureauGoalRecoveryOutcome;
  readonly attempt?: BureauGoalAttemptRecovery | undefined;
  /** For `cancellation-pending`: what the read-back found unfinished. */
  readonly awaiting?: readonly BureauGoalCancellationWait[] | undefined;
  readonly detail?: string | undefined;
}

export interface BureauGoalRecoveryReport {
  readonly goals: readonly BureauGoalRecoveryEntry[];
  /** Goals recovery could not process at all. Never thrown. */
  readonly failures: readonly { readonly goalRunId: string; readonly reason: string }[];
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

export interface BureauGoals<TName extends string = string> {
  /**
   * Persists the goal, then starts its controller. The record is written
   * first, so a crash between the two is healed by `recover()` or by repeating
   * this call with the same id.
   */
  create(request: BureauGoalRequest<TName>): Promise<BureauGoalCreateOutcome>;
  get(goalRunId: string, query?: BureauGoalQuery): Promise<GoalState | undefined>;
  /** Terminal and closed goals are included. Oldest first. */
  list(options?: BureauGoalListOptions): Promise<GoalState[]>;
  /** The attempt run or validation execution in flight, or `undefined` when none is. */
  active(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalActiveWork | undefined>;
  cancel(goalRunId: string, options?: BureauGoalCancelOptions): Promise<BureauGoalCancelOutcome>;
  /**
   * One goal when an id is named, otherwise the sweep over every goal that is
   * not terminal and that the principal may see (all of them when it is
   * omitted). Idempotent, and never throws.
   */
  recover(goalRunId?: string, query?: BureauGoalQuery): Promise<BureauGoalRecoveryReport>;
  /** Terminal goals only. Idempotent; each call re-applies the checkpoint retention. */
  close(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalCloseOutcome>;
}
