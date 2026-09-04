import type {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
} from '@lostgradient/operative';
import type { LivenessLeaseEvidence } from '@lostgradient/operative/liveness';
import type { Action } from '@lostgradient/operative/store';
import type { EventMap } from 'lifecycle';

/**
 * Fired when the store records an action from a run.
 */
export class ActionEvent extends Event {
  static readonly type = 'action' as const;

  readonly action: Action;

  constructor(action: Action) {
    super(ActionEvent.type);
    this.action = action;
  }
}

/**
 * Fired when a new run is registered in the store.
 */
export class RunRegisteredEvent extends Event {
  static readonly type = 'run.registered' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRegisteredEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when a run is removed from the store.
 */
export class RunRemovedEvent extends Event {
  static readonly type = 'run.removed' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRemovedEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when the bureau is disposed.
 */
export class BureauDisposedEvent extends Event {
  static readonly type = 'bureau.disposed' as const;

  constructor() {
    super(BureauDisposedEvent.type);
  }
}

/**
 * `classifyRecoveredRun`'s five possible outcomes (AB-90/ab90-09). Named here
 * rather than re-derived at each call site, so `RecoveryAttemptedEvent`'s
 * `verdict` field and `classifyRecoveredRun`'s own return type share one
 * definition.
 */
export type RecoveredRunVerdict =
  'reattach' | 'reattach-version-mismatch' | 'monitor' | 'cancel' | 'skip';

/**
 * Fired every time `classifyRecoveredRun` runs during boot recovery — for
 * every recovered handle, regardless of verdict — making today's
 * internal-only classification (AB-87's Recovery surface table) externally
 * observable for the first time. Dispatched immediately after the verdict is
 * computed, before any branch-specific handling (reattach, monitor, cancel).
 */
export class RecoveryAttemptedEvent extends Event {
  static readonly type = 'recovery.attempted' as const;

  readonly runId: string;
  readonly verdict: RecoveredRunVerdict;

  constructor(runId: string, verdict: RecoveredRunVerdict) {
    super(RecoveryAttemptedEvent.type);
    this.runId = runId;
    this.verdict = verdict;
  }
}

/**
 * Why `classifyRecoveredRun` positively rejected a recovered handle (its
 * `'cancel'` verdict) rather than reattaching, monitoring, or skipping it
 * pending confirmation. Mirrors `classifyRecoveredRun`'s own `'cancel'`
 * branches exactly — see `create-bureau.ts`'s `classifyRecoveredRunDetailed`,
 * the single source of truth both the verdict and this reason are derived
 * from in one pass, so the two can never drift.
 */
export type RecoveryRejectionReason =
  | 'metadata-read-failed'
  | 'foreign-input'
  | 'session-absent'
  | 'session-run-mismatch'
  | 'session-not-running';

/**
 * Fired only when `classifyRecoveredRun`'s verdict is `'cancel'` — a
 * positive rejection, distinct from a successful reattachment (`'reattach'`/
 * `'reattach-version-mismatch'`), a headless `'monitor'`, or an indeterminate
 * `'skip'` (ownership could not be confirmed, so nothing is rejected).
 * Always dispatched after the corresponding `RecoveryAttemptedEvent` for the
 * same `runId`.
 */
export class RecoveryRejectedEvent extends Event {
  static readonly type = 'recovery.rejected' as const;

  readonly runId: string;
  readonly reason: RecoveryRejectionReason;

  constructor(runId: string, reason: RecoveryRejectionReason) {
    super(RecoveryRejectedEvent.type);
    this.runId = runId;
    this.reason = reason;
  }
}

/**
 * Fired when boot recovery observes that a Weft-held engine lease this run's
 * recovery depended on was released — projecting `Engine.getLeaseHealth()`'s
 * contested-with-holder-record shape (see
 * `liveness-projection.ts`'s `leaseEvidenceFromLostHealth`), never a
 * Bureau-owned lease of its own (AB-39's ownership map: Weft is sole owner of
 * lease state). Not dispatched for a currently-held, healthy lease, nor for
 * the sparsest contested shape (no holder record to relay) — both would
 * require fabricating evidence Weft did not actually report.
 */
export class RecoveryLeaseReleasedEvent extends Event {
  static readonly type = 'recovery.lease-released' as const;

  readonly runId: string;
  readonly lease: LivenessLeaseEvidence;

  constructor(runId: string, lease: LivenessLeaseEvidence) {
    super(RecoveryLeaseReleasedEvent.type);
    this.runId = runId;
    this.lease = lease;
  }
}

/**
 * The two {@link PendingReview} kinds a `review.*` event may report on.
 * Declared locally rather than imported from `./types` (which itself
 * imports {@link BureauEventMap} from this module) so this file stays free
 * of a type-only import cycle — the same reason {@link RecoveredRunVerdict}
 * above is a local literal union rather than re-exported from `types.ts`.
 */
export type ReviewEventKind = 'tool-approval' | 'human-wait';

/**
 * Base of AB-224's `review.*` lifecycle event family (implementing AB-87's
 * event matrix and AB-46's `ReviewStatus` vocabulary). Carries only
 * `reviewId`, `runId`, `principal`, and `kind` — never the review's own
 * `approval`/`signalName`/`prompt`/decision `reason`, which stay privileged
 * per AB-87's redaction column and surface only through the durable audit
 * trail (`recordReviewDecision`/`recordReviewStatusTransition` in
 * `create-bureau.ts`), a separately-redacted surface.
 *
 * One event per non-`'pending'` `ReviewStatus` value; `pending` itself
 * dispatches nothing — per AB-87, "pending is the resting state before any
 * armorer signal fires":
 *
 * | `ReviewStatus` | Event                |
 * | -------------- | --------------------- |
 * | `pending`      | none — resting state  |
 * | `approved`     | `review.approved`     |
 * | `denied`       | `review.denied`       |
 * | `rejected`     | `review.rejected`     |
 * | `expired`      | `review.expired`      |
 * | `revoked`      | `review.revoked`      |
 * | `canceled`     | `review.canceled`     |
 * | `superseded`   | `review.superseded`   |
 */
class ReviewLifecycleEvent extends Event {
  readonly reviewId: string;
  readonly runId: string;
  readonly principal: string;
  readonly kind: ReviewEventKind;

  constructor(
    type: string,
    reviewId: string,
    runId: string,
    principal: string,
    kind: ReviewEventKind,
  ) {
    super(type);
    this.reviewId = reviewId;
    this.runId = runId;
    this.principal = principal;
    this.kind = kind;
  }
}

/** Fired when `resolveReview({ decision: 'approve' })` settles a review (AB-224). */
export class ReviewApprovedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.approved' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewApprovedEvent.type, reviewId, runId, principal, kind);
  }
}

/** Fired when `resolveReview({ decision: 'deny' })` settles a review (AB-224). */
export class ReviewDeniedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.denied' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewDeniedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `resolveReview({ decision: 'reject' })` settles a review
 * (AB-224). Distinct from {@link ReviewDeniedEvent} — `reject` is AB-46's
 * new verb, never dispatched by the plain `deny` path.
 */
export class ReviewRejectedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.rejected' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewRejectedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `Bureau.sweepExpiredReviews` transitions a tool-approval
 * review past its binding's `expiresAt` (AB-224). Always attributed to the
 * synthetic principal `'system:expiry-sweep'`.
 */
export class ReviewExpiredEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.expired' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewExpiredEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `deleteRun`/`deleteSession` revoke a still-pending review via
 * `revokePendingApprovalsForRun` (AB-224). Attributed to
 * `'system:run-deletion'` or `'system:session-deletion'`. Distinct from
 * {@link ReviewCanceledEvent} — revoked fires only from explicit run/session
 * deletion, never from run abort.
 */
export class ReviewRevokedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.revoked' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewRevokedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `abortRun`/`cancelDurableRun` cancel a still-pending review via
 * `revokePendingApprovalsForRun` (AB-224). Always attributed to the
 * synthetic principal `'system:run-abort'`. Distinct from
 * {@link ReviewRevokedEvent} — canceled fires only from run abort, never
 * from explicit run/session deletion.
 */
export class ReviewCanceledEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.canceled' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewCanceledEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `resumeApproval`'s re-gate produces a new `pendingApproval` for
 * the same `callId` (AB-224): the ORIGINAL tool-approval review is marked
 * `superseded` while a fresh `'pending'` review sharing the same id takes
 * its place. Always attributed to the synthetic principal
 * `'system:supersession'`.
 */
export class ReviewSupersededEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.superseded' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewSupersededEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Maps event type strings to their corresponding Event subclasses.
 *
 * `schedule.created`/`paused`/`resumed`/`cancelled`/`failed`/`completed`
 * (AB-223/AB-298) are defined in `@lostgradient/operative` (alongside
 * `schedule.wakeup`) rather than here, but dispatched on THIS bureau-level
 * emitter — not a per-run operative emitter — because a schedule
 * create/pause/resume/cancel and a scheduled fire's terminal outcome are
 * bureau-level facts with no owning per-run surface (scheduled fires are
 * headless; see `runtime-composition.ts`'s `buildScheduledRunServices`).
 * `schedule.created` reaches this emitter differently from the other five:
 * `Bureau.createSchedule` passes this bureau's own `emitter` into
 * `createAgentScheduler`, so `createAgentSchedule` (AB-298) dispatches
 * directly onto it, rather than `create-bureau.ts` dispatching a second copy
 * itself the way `pauseSchedule`/`resumeSchedule`/`cancelSchedule` do.
 */
export interface BureauEventMap extends EventMap {
  [ActionEvent.type]: ActionEvent;
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunRemovedEvent.type]: RunRemovedEvent;
  [BureauDisposedEvent.type]: BureauDisposedEvent;
  [RecoveryAttemptedEvent.type]: RecoveryAttemptedEvent;
  [RecoveryRejectedEvent.type]: RecoveryRejectedEvent;
  [RecoveryLeaseReleasedEvent.type]: RecoveryLeaseReleasedEvent;
  'schedule.created': AgentScheduledEvent;
  'schedule.paused': SchedulePausedEvent;
  'schedule.resumed': ScheduleResumedEvent;
  'schedule.cancelled': ScheduleCancelledEvent;
  'schedule.failed': ScheduleFailedEvent;
  'schedule.completed': ScheduleCompletedEvent;
  [ReviewApprovedEvent.type]: ReviewApprovedEvent;
  [ReviewDeniedEvent.type]: ReviewDeniedEvent;
  [ReviewRejectedEvent.type]: ReviewRejectedEvent;
  [ReviewExpiredEvent.type]: ReviewExpiredEvent;
  [ReviewRevokedEvent.type]: ReviewRevokedEvent;
  [ReviewCanceledEvent.type]: ReviewCanceledEvent;
  [ReviewSupersededEvent.type]: ReviewSupersededEvent;
}
