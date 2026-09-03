import type { Subscription } from 'lifecycle';

export type { Subscription };

/**
 * Liveness, progress, and stuck-work types — the binding shapes ratified by
 * AB-88's decision record (`## Decision (2026-09-01)`), implemented by
 * AB-214 (obs-01). See `packages/operative/src/liveness/policies.ts` for the
 * per-operation `StallPolicy` rows and `watchdog.ts` for `createStallWatchdog`,
 * the single timer-agnostic implementation of this contract's cadence/grace/
 * jitter/missed-pulse math.
 *
 * Type re-exports for this subpath live here rather than in a barrel
 * `index.ts`, per this repository's module-organization convention.
 */

// ---------------------------------------------------------------------------
// AC2/AC3 — subject inventory
// ---------------------------------------------------------------------------

export type LivenessSubjectKind =
  | 'agent-run'
  | 'provider-turn'
  | 'tool-call'
  | 'child-run'
  | 'session'
  | 'schedule-fire'
  | 'scheduler-task'
  | 'background-evaluation'
  | 'webhook-delivery'
  | 'gateway-connection'
  | 'weft-activity'
  | 'weft-worker'
  | 'weft-task'
  | 'weft-stream'
  | 'weft-engine-lease';

// ---------------------------------------------------------------------------
// AC1 — dimensions
// ---------------------------------------------------------------------------

/**
 * AC1's lifecycle dimension, carried by the snapshot's own `status` field,
 * never a second `lifecycle` field.
 */
export type LivenessLifecycleStatus =
  'created' | 'queued' | 'running' | 'waiting' | 'aborting' | 'cleaning-up' | 'terminal';

export type LivenessReachability =
  'unknown' | 'reachable' | 'late' | 'unreachable' | 'not-applicable';

export type LivenessProgressState =
  'unknown' | 'progressing' | 'idle' | 'stalled' | 'not-applicable';

/**
 * Derived single-glance classification; reconstructible from the raw fields
 * and never fed back as evidence.
 */
export type LivenessAssessment =
  | 'healthy'
  | 'legitimately-waiting'
  | 'alive-but-stalled'
  | 'unreachable'
  | 'aborting'
  | 'cleaning-up'
  | 'terminal';

// ---------------------------------------------------------------------------
// AC6 — declared waits
// ---------------------------------------------------------------------------

export type DeclaredWaitReason =
  | 'queue-capacity'
  | 'backpressure'
  | 'sleep'
  | 'signal'
  | 'review'
  | 'child'
  | 'provider'
  | 'tool'
  | 'retry'
  | 'rate-limit';

export interface DeclaredWait {
  readonly reason: DeclaredWaitReason;
  readonly startedAt: number;
  /** id of the awaited thing (childRunId, review id). */
  readonly owner?: string;
  /** provider name, tool callId, rate-limit window. */
  readonly dependency?: string;
  /**
   * Absent means unbounded; legal only for `'signal'` and `'review'`.
   * `'sleep'`, `'retry'`, and `'rate-limit'` must carry a deadline.
   */
  readonly deadline?: number;
  readonly wakeCondition: string;
}

// ---------------------------------------------------------------------------
// AC7 — stall policy
// ---------------------------------------------------------------------------

export type LivenessClockSource = 'monotonic-observer' | 'wall-clock-owner';
export type LivenessSuspensionBehavior = 'pause-on-suspected-suspension' | 'not-applicable';
export type LivenessRecoveryRule =
  'resume-on-next-pulse' | 'requires-explicit-recovered-transition';

export interface StallPolicy {
  /** Never a single global key. */
  readonly operation: string;
  readonly cadenceMs?: number;
  readonly graceMs: number;
  readonly jitterMs: number;
  readonly missedPulseThreshold: number;
  /**
   * A duration in milliseconds relative to the watchdog's construction time
   * (`constructedAt + absoluteDeadlineMs`), never a raw clock-coordinate
   * timestamp — "absolute" names this deadline's non-renewable, non-cadence
   * relationship to attempts (AC7), not its unit. AB-88's stall-policy table
   * ties every row's absolute deadline to an existing duration-style budget
   * (a tool's `timeout`, a caller's per-request timeout), confirmed against
   * the bot review at PRRT_kwDORvupsc6etXKc, which read this as a
   * clock-coordinate deadline needing no rebasing — it is not.
   */
  readonly absoluteDeadlineMs?: number;
  readonly clockSource: LivenessClockSource;
  readonly suspensionBehavior: LivenessSuspensionBehavior;
  readonly recovery: LivenessRecoveryRule;
}

// ---------------------------------------------------------------------------
// AC5 — evidence isolation
// ---------------------------------------------------------------------------

export type LivenessEvidenceSource =
  | 'host-reachability'
  | 'transport-keepalive'
  | 'provider-io'
  | 'tool-progress'
  | 'worker-session-heartbeat'
  | 'task-attempt-heartbeat'
  | 'lease-renewal'
  | 'absolute-deadline';

export interface LivenessEvidenceEntry {
  readonly source: LivenessEvidenceSource;
  readonly at: number;
  readonly attempt: number;
  readonly detail?: unknown;
}

// ---------------------------------------------------------------------------
// AC4 — the liveness snapshot
// ---------------------------------------------------------------------------

export interface SemanticProgress<TDetail = unknown> {
  readonly phase?: string;
  readonly current?: number;
  readonly total?: number;
  readonly unit?: string;
  readonly message?: string;
  readonly checkpoint?: TDetail;
}

export interface LivenessLeaseEvidence {
  readonly holderId: string;
  readonly expiresAt: number;
  /** Weft's `LeaseManager` epoch, never fabricated by Bureau. */
  readonly epoch?: number;
  readonly source: 'weft-workflow-lease' | 'weft-activity-lease' | 'weft-worker-registry';
}

/** Satisfies AB-15/AB-34's `StartedWorkSnapshot` floor structurally, under the floor's own field names. */
export interface LivenessSnapshot<TResult = unknown, TCheckpoint = unknown> {
  readonly id: string;
  readonly kind: LivenessSubjectKind;
  /** Principal or bureau identifier per the floor; absent for a standalone run. */
  readonly owner?: string;
  /** AC3's aggregating parent. */
  readonly parentId?: string;
  readonly startedAt: string;
  readonly revision: number;
  readonly status: LivenessLifecycleStatus;
  readonly lastTransitionAt: string;
  readonly projection: 'redacted' | 'privileged';
  readonly ownership: 'independent' | 'parent-owned' | 'inline';
  readonly detached: boolean;
  readonly durability: 'process-local' | 'durable';
  readonly cancellable: boolean;
  readonly result?: TResult;
  /** Attempt fencing token (AC8); monotonic per id. Older-attempt evidence is discarded on ingestion. */
  readonly attempt: number;
  readonly reachability: LivenessReachability;
  readonly progress: LivenessProgressState;
  readonly assessment: LivenessAssessment;
  /** Source wall clock; absent for watchdog-derived states. */
  readonly emittedAt?: number;
  /** Observer monotonic clock; the clock all cadence math uses. */
  readonly observedAt: number;
  readonly lastActivityAt?: number;
  readonly lastHeartbeatAt?: number;
  readonly lastProgressAt?: number;
  readonly expectedNextObservationAt?: number;
  readonly missedPulseCount: number;
  readonly semanticProgress?: SemanticProgress<TCheckpoint>;
  /** Present iff `status` is `'waiting'`. */
  readonly declaredWait?: DeclaredWait;
  readonly lease?: LivenessLeaseEvidence;
  /** Absolute execution deadline; never moved by a stale pulse. */
  readonly deadline?: number;
  readonly policyVersion: string;
  /** Ordered, most recent last. */
  readonly evidence: readonly LivenessEvidenceEntry[];
  /**
   * AB-216's child-liveness rollup (extension against AB-88's
   * `## Decision (2026-09-01)` `LivenessSnapshot` section, added
   * non-breakingly as an additional optional field, per that section's own
   * extension discipline). The most severe `LivenessAssessment` among this
   * run's non-terminal children (`assessment !== 'terminal'`), using the
   * order `unreachable` > `alive-but-stalled` > `aborting` > `cleaning-up`
   * > `legitimately-waiting` > `healthy` — `aborting` and `cleaning-up`
   * rank between `alive-but-stalled` and `legitimately-waiting` because
   * they are transitional-but-expected states worth surfacing above an
   * ordinary healthy or waiting child, but are not themselves liveness
   * breaches the way `unreachable`/`alive-but-stalled` are. Absent when
   * there are no children, or every child is terminal — never a stale
   * value from a prior tick. Computed from each child's own
   * already-computed `assessment` only: a child's own `StallPolicy`
   * selection, cadence, and watchdog instance are never read, overridden,
   * or substituted by this run's aggregation (AB-88's "delegated policy"
   * obligation), and a stalled child never changes this run's own
   * `reachability`/`progress`/`status` — only this field reflects it.
   */
  readonly worstChildAssessment?: LivenessAssessment;
}

// ---------------------------------------------------------------------------
// AC10 — non-consuming observation
// ---------------------------------------------------------------------------

export interface LivenessObservable<TSnapshot extends LivenessSnapshot> {
  /** Synchronous, never starts work, never blocks, never mutates. */
  snapshot(): TSnapshot;
  /**
   * Independent observer; disposal ends only this subscription. Delivers the
   * current snapshot synchronously before returning, then every revision
   * change; already-terminal work delivers the terminal snapshot once.
   */
  subscribeSnapshot(
    observer: (snapshot: TSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
}
