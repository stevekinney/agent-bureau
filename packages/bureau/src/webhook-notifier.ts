/**
 * Notification delivery for pending approvals (AB-21).
 *
 * Fires configured webhooks for three human-attention triggers:
 *
 * - `elicitation.requested` — an MCP tool asked the human a question inline
 *   (resolved synchronously via `onElicitation`, never lands in the AB-20
 *   review queue). The deep link points at the run detail page
 *   (`/runs/:id`) since there is no review-queue item to link to.
 * - `approval-pending` — a NEW `tool-approval` item appeared in
 *   {@link Bureau.listPendingReviews}. Synthesized here (armorer emits no
 *   discrete bubble event for "pending approval"; it is a derived read of
 *   `step.completed` results), detected by diffing `listPendingReviews()`
 *   against the ids already notified.
 * - `human-wait.parked` — a NEW `human-wait` item appeared in
 *   `listPendingReviews()` (backed by operative's `HumanWaitParkedEvent`).
 * - `eval.threshold-breached` — fired out-of-band via {@link WebhookNotifier.notify}
 *   rather than derived from the action stream (there is no bureau event for
 *   it). AB-53's online eval sampler is the only current caller: a judge's
 *   score breaches its configured alert threshold and calls `notify()`
 *   directly, reusing this module's persist/retry/backoff pipeline instead of
 *   duplicating it.
 *
 * Both queue-backed triggers deep-link to `/reviews?id=<reviewId>` — the
 * AB-20 review queue's only route (`/reviews`, no `:id` segment), so the
 * link is a query-string pointer into the same list the UI already renders.
 *
 * Delivery is durable, not fire-and-forget: each delivery is persisted to
 * the bureau's KV store (`webhook-delivery:v1:` prefix, the same store the
 * audit trail uses) before the first attempt, retried with exponential
 * backoff (`sleep`/`now` are both injectable for deterministic tests, same
 * pattern as `sessionPersistenceSleep`), and marked `delivered` or
 * `exhausted` in place. An exhausted delivery is also recorded in the audit
 * trail (`webhook.delivery.exhausted`) so the failure is visible on the
 * bureau's existing audit surface, not just buried in a KV record nobody
 * reads.
 *
 * Restart-resumption of in-flight `pending` deliveries is out of scope for
 * v1 — see the module doc on `listDeliveries` for the exact guarantee this
 * gives instead (durable de-duplication, not durable resumption).
 *
 * Each in-flight delivery also gets a per-delivery `LivenessSnapshot`
 * (AB-220), watched via `createStallWatchdog` against a `webhook-delivery`
 * `StallPolicy` row (AB-214) whose `absoluteDeadlineMs` is computed per
 * delivery from that delivery's own `maxAttempts`/`backoffBaseMilliseconds`
 * — the worst-case total elapsed backoff before it gives up. This is a
 * detection backstop for a single hung `fetchImpl` call: the delivery loop
 * has no per-request `AbortSignal`/fetch timeout of its own, so a hung
 * request can otherwise exceed the computed deadline without the delivery
 * code itself noticing.
 */
import {
  createStallWatchdog,
  LIVENESS_POLICY_VERSION,
  type LivenessAssessment,
  type LivenessLifecycleStatus,
  type LivenessObservable,
  type LivenessProgressState,
  type LivenessReachability,
  type LivenessSnapshot,
  type StallPolicy,
  type StallWatchdog,
  type StallWatchdogClock,
  type Subscription,
  WEBHOOK_DELIVERY_POLICY,
} from '@lostgradient/operative/liveness';
import type { TextValueStore } from '@lostgradient/weft/storage';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import type { AuditTrail } from './audit-trail';
import type { ActionEvent } from './events';
import { resolveDiagnosticSink } from './serialization';
import type { Bureau, DiagnosticSink, PendingReview } from './types';

// ── Public surface ──────────────────────────────────────────────────

/** The trigger types that fire a configured webhook. */
export type WebhookTriggerType =
  'elicitation.requested' | 'approval-pending' | 'human-wait.parked' | 'eval.threshold-breached';

/** A configured webhook delivery target. */
export interface WebhookTarget {
  /** Destination URL a delivery is POSTed to. */
  url: string;
  /**
   * Restrict this target to a subset of trigger types. Omit to receive all
   * three ({@link WebhookTriggerType}).
   */
  events?: WebhookTriggerType[];
}

/** A single webhook delivery's liveness snapshot (AB-220). */
export type WebhookDeliveryLivenessSnapshot = LivenessSnapshot & { kind: 'webhook-delivery' };

/**
 * The `absoluteDeadlineMs` for a webhook delivery (AB-220): the worst-case
 * total elapsed backoff across every retry attempt before the delivery
 * gives up — `backoffBaseMilliseconds * (2 ** (maxAttempts - 1) - 1)`,
 * matching this module's own `deliver()` backoff schedule
 * (`backoffBaseMilliseconds * 2 ** (attempt - 1)`, summed across the
 * `maxAttempts - 1` retries after the first attempt). Exported for direct
 * unit testing against `DEFAULT_MAX_ATTEMPTS`/`DEFAULT_BACKOFF_BASE_MILLISECONDS`
 * and a caller override.
 */
export function computeWebhookDeliveryDeadlineMs(
  maxAttempts: number,
  backoffBaseMilliseconds: number,
): number {
  return backoffBaseMilliseconds * (2 ** (maxAttempts - 1) - 1);
}

function webhookDeliveryPolicy(maxAttempts: number, backoffBaseMilliseconds: number): StallPolicy {
  return {
    ...WEBHOOK_DELIVERY_POLICY,
    absoluteDeadlineMs: computeWebhookDeliveryDeadlineMs(maxAttempts, backoffBaseMilliseconds),
  };
}

/**
 * The default production clock backing each delivery's
 * `createStallWatchdog` — `performance.now()`, a monotonic source, matching
 * `active-run-liveness.ts`'s own default clock. Distinct from this module's
 * own `now` option, which is `Date.now`-based and only ever timestamps
 * persisted `WebhookDeliveryRecord`s. Exported for direct unit testing of
 * `setTimeout`/`clearTimeout` (AB-220): the `webhook-delivery` policy row
 * has `missedPulseThreshold: 0`, so `createStallWatchdog` never actually
 * calls either through the public API — see
 * `packages/operative/src/liveness/watchdog.ts`'s `scheduleNextCheck`,
 * which no-ops when a policy isn't cadence-gated.
 */
export const realWatchdogClock: StallWatchdogClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The fixed id for the notifier's own instance-level aggregate snapshot. */
const AGGREGATE_DELIVERY_ID = 'webhook-notifier';

/**
 * AB-216's child-liveness severity ordering
 * (`packages/operative/src/liveness/active-run-liveness.ts`), duplicated at
 * module-local scope rather than imported: this issue's delivery boundary
 * restricts its edit to `online-evals.ts`/`webhook-notifier.ts` and their
 * tests, and the source ordering is not part of `@lostgradient/operative`'s
 * public `liveness` subpath export.
 */
const ASSESSMENT_SEVERITY: readonly Exclude<LivenessAssessment, 'terminal'>[] = [
  'unreachable',
  'alive-but-stalled',
  'aborting',
  'cleaning-up',
  'legitimately-waiting',
  'healthy',
];

/**
 * Folds a set of non-terminal assessments down to the single most severe
 * one, defaulting to `'healthy'` when empty. Exported for direct unit
 * testing (AB-220): before a delivery's computed deadline passes it always
 * reports `'healthy'` (no cadence), so the "found something worse" branch
 * is otherwise unreachable through the public API without a real hung
 * request outliving the deadline.
 */
export function worstAssessment(assessments: readonly LivenessAssessment[]): LivenessAssessment {
  let worst: LivenessAssessment = 'healthy';
  let worstRank = ASSESSMENT_SEVERITY.indexOf('healthy');
  for (const assessment of assessments) {
    if (assessment === 'terminal') continue;
    const rank = ASSESSMENT_SEVERITY.indexOf(assessment);
    if (rank === -1 || rank >= worstRank) continue;
    worstRank = rank;
    worst = assessment;
  }
  return worst;
}

const REACHABILITY_RANK: readonly LivenessReachability[] = ['reachable', 'late', 'unreachable'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstReachability(values: readonly LivenessReachability[]): LivenessReachability {
  let worst: LivenessReachability = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = REACHABILITY_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

const PROGRESS_RANK: readonly LivenessProgressState[] = ['progressing', 'idle', 'stalled'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstProgress(values: readonly LivenessProgressState[]): LivenessProgressState {
  let worst: LivenessProgressState = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = PROGRESS_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

/** Mirrors `active-run-liveness.ts`'s `deriveAssessment` for this module's own status dimension. */
function deriveDeliveryAssessment(
  status: LivenessLifecycleStatus,
  reachability: LivenessReachability,
  progress: LivenessProgressState,
): LivenessAssessment {
  if (status === 'terminal') return 'terminal';
  if (status === 'aborting') return 'aborting';
  if (status === 'cleaning-up') return 'cleaning-up';
  if (reachability === 'unreachable') return 'unreachable';
  if (status === 'waiting') return 'legitimately-waiting';
  if (progress === 'stalled') return 'alive-but-stalled';
  return 'healthy';
}

/** Options for {@link createWebhookNotifier}. */
export interface WebhookNotifierOptions {
  /** Configured delivery targets. Omit or pass `[]` to disable delivery entirely. */
  targets: WebhookTarget[];
  /**
   * Base URL prepended to the deep-link path (`/reviews?id=...` or
   * `/runs/:id`). Omit to emit a relative path — the caller resolves it
   * against whatever origin serves the gateway UI.
   */
  reviewQueueBaseUrl?: string;
  /** Injectable HTTP client. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable backoff sleep. Defaults to the composed RuntimeServices timers. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable clock. Defaults to the composed RuntimeServices clock. */
  now?: () => number;
  /** Maximum delivery attempts before a delivery is marked `exhausted`. Default `5`. */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds; doubles on every retry. Default `1000`. */
  backoffBaseMilliseconds?: number;
  /**
   * Owner-issued signal threaded into every `deliver()` call's `fetchImpl`
   * invocation (AB-37/AB-206). Aborting it stops further retry attempts for
   * every in-flight delivery and records each one's persisted status as
   * `aborted` rather than leaving it `pending` forever. `dispose()` still
   * awaits that settlement via `flush()`.
   */
  signal?: AbortSignal;
  /**
   * Injectable timer-agnostic clock backing each delivery's
   * `createStallWatchdog` (AB-220). Defaults to a `performance.now()`-based
   * clock. Tests inject a manual clock so no real sleeps are needed.
   */
  clock?: StallWatchdogClock;
}

/** The persisted record for a single webhook delivery. */
export interface WebhookDeliveryRecord {
  /** `<subjectId>:<targetIndex>` — stable across retries and restarts. */
  id: string;
  triggerType: WebhookTriggerType;
  targetUrl: string;
  runId: string;
  status: 'pending' | 'delivered' | 'exhausted' | 'aborted';
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookNotifier extends LivenessObservable<WebhookDeliveryLivenessSnapshot> {
  /**
   * List every persisted delivery record (for diagnostics/tests). Best-effort:
   * returns `[]` when no KV store is configured (ephemeral bureau).
   */
  listDeliveries(): Promise<WebhookDeliveryRecord[]>;
  /**
   * Await every delivery currently in flight (mid-attempt or mid-backoff).
   * Used by tests to observe a delivery's terminal state deterministically
   * without racing real timers; also useful for a caller that wants to drain
   * outstanding deliveries before shutting down.
   */
  flush(): Promise<void>;
  /**
   * Fire a delivery out-of-band, reusing the same durable persist/retry/backoff
   * pipeline the action-stream-derived triggers use. For callers with no
   * corresponding bureau action to derive a trigger from — AB-53's online eval
   * sampler, which alerts on a threshold breach that has no bureau event.
   *
   * @param input.subjectId - Stable id for this notification, deduplicated
   *   the same way as the action-stream triggers (`<subjectId>:<targetIndex>`)
   *   — calling `notify()` twice with the same `subjectId` and trigger kicks
   *   off delivery only once.
   * @param input.detail - Extra fields merged into the delivered payload
   *   under `detail`.
   */
  notify(input: {
    runId: string;
    subjectId: string;
    trigger: WebhookTriggerType;
    detail?: Record<string, unknown>;
  }): void;
  /**
   * Stop listening to bureau events, abandon any in-flight backoff waits, and
   * await every in-flight `deliver()` call tracked in `activeDeliveries`
   * before resolving (AB-37/AB-206). Safe to call more than once — the
   * second call resolves promptly.
   */
  dispose(): Promise<void>;
  /**
   * Per-delivery `LivenessSnapshot`s for every delivery currently in flight
   * (AB-220), most-recently-started last. `snapshot()` (from
   * {@link LivenessObservable}) reports the instance-level aggregate — the
   * worst assessment across these — for a caller holding only the notifier
   * handle.
   */
  activeDeliverySnapshots(): WebhookDeliveryLivenessSnapshot[];
}

// ── Key encoding ────────────────────────────────────────────────────

const PREFIX = 'webhook-delivery:v1:';

function encodeKey(id: string): string {
  return `${PREFIX}${id}`;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MILLISECONDS = 1000;

/**
 * Factory for the default backoff sleep — driven by the composed
 * {@link RuntimeServices.timers} (AB-260). `timers` is required (its one
 * caller, below, always supplies `runtime.timers`, itself already defaulted
 * to the real-globals runtime by `createWebhookNotifier`'s own `runtime`
 * parameter) — the baseline behavior is unchanged from before
 * `RuntimeServices` composition. The timer-scheduling member is destructured
 * once so the call site below reads `scheduleTimeout(...)` rather than a
 * literal `timers` method call — see `create-bureau.ts`'s equivalent pattern
 * for why.
 */
function createDefaultSleep(
  timers: RuntimeServices['timers'],
): (milliseconds: number) => Promise<void> {
  const { setTimeout: scheduleTimeout } = timers;
  function sleep(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = scheduleTimeout(resolve, milliseconds);
      // Never keep the process alive purely to finish a webhook backoff wait —
      // matches the "best-effort, never blocks shutdown" posture of the audit
      // trail's fire-and-forget writes.
      (timer as { unref?: () => void }).unref?.();
    });
  }
  return sleep;
}

// ── Deep links ──────────────────────────────────────────────────────

function buildDeepLink(path: string, baseUrl: string | undefined): string {
  if (!baseUrl) return path;
  return new URL(path, baseUrl).toString();
}

function reviewDeepLink(reviewId: string, baseUrl: string | undefined): string {
  return buildDeepLink(`/reviews?id=${encodeURIComponent(reviewId)}`, baseUrl);
}

function runDeepLink(runId: string, baseUrl: string | undefined): string {
  return buildDeepLink(`/runs/${encodeURIComponent(runId)}`, baseUrl);
}

// ── Payload ─────────────────────────────────────────────────────────

interface WebhookPayload {
  trigger: WebhookTriggerType;
  runId: string;
  reviewId?: string;
  deepLink: string;
  message?: string;
  prompt?: string;
  requestedAt: number;
  /** Extra fields for out-of-band triggers fired via {@link WebhookNotifier.notify}. */
  detail?: Record<string, unknown>;
}

function reviewTriggerType(kind: PendingReview['kind']): WebhookTriggerType {
  return kind === 'tool-approval' ? 'approval-pending' : 'human-wait.parked';
}

function targetsFor(targets: WebhookTarget[], trigger: WebhookTriggerType): WebhookTarget[] {
  return targets.filter((target) => !target.events || target.events.includes(trigger));
}

// ── Notifier factory ────────────────────────────────────────────────

/**
 * Creates the webhook notifier attached to `bureau`.
 *
 * @param bureau - The bureau to observe (its `action` event stream).
 * @param kv - The KV store to persist delivery state into. `undefined` when
 *   the bureau has no persistence configured — delivery still happens, just
 *   without durable de-duplication across restarts.
 * @param auditTrail - The bureau's audit trail. An exhausted delivery is
 *   recorded here (`webhook.delivery.exhausted`) so the failure is visible on
 *   the bureau's existing durable observability surface.
 * @param options - Targets + tuning knobs. Returns a no-op notifier when
 *   `options` is `undefined` or `options.targets` is empty.
 * @param onDiagnostic - Host sink for operational diagnostics (persistence
 *   failures). Omit to log to the console, matching prior behavior.
 */
export function createWebhookNotifier<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  kv: TextValueStore | undefined,
  auditTrail: AuditTrail | undefined,
  options: WebhookNotifierOptions | undefined,
  onDiagnostic?: DiagnosticSink,
  // AB-260: the bureau's single composed `RuntimeServices` instance. Defaults
  // to the real-globals runtime so every pre-existing direct caller of this
  // exported factory (including this package's own test suite) is
  // unaffected by construction. `options.sleep`/`options.now` (this module's
  // own pre-existing injectable seam) still take precedence when supplied.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): WebhookNotifier {
  const diagnose = resolveDiagnosticSink(onDiagnostic);
  const targets = options?.targets ?? [];

  if (targets.length === 0) {
    const noOpSnapshot: WebhookDeliveryLivenessSnapshot = Object.freeze({
      id: AGGREGATE_DELIVERY_ID,
      kind: 'webhook-delivery',
      startedAt: new Date().toISOString(),
      revision: 0,
      status: 'terminal',
      lastTransitionAt: new Date().toISOString(),
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: 'not-applicable',
      progress: 'not-applicable',
      assessment: 'terminal',
      observedAt: 0,
      missedPulseCount: 0,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
    return {
      listDeliveries() {
        return Promise.resolve([]);
      },
      async flush() {
        // Nothing was ever kicked off.
      },
      notify() {
        // No targets configured — nothing to deliver.
      },
      async dispose() {
        // Nothing was ever subscribed.
      },
      activeDeliverySnapshots() {
        return [];
      },
      snapshot() {
        return noOpSnapshot;
      },
      subscribeSnapshot(observer) {
        observer(noOpSnapshot);
        return { unsubscribe() {}, closed: true };
      },
    };
  }

  const fetchImpl = options?.fetch ?? fetch;
  const signal = options?.signal;
  const sleep = options?.sleep ?? createDefaultSleep(runtime.timers);
  const now = options?.now ?? runtime.clock.now;
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMilliseconds =
    options?.backoffBaseMilliseconds ?? DEFAULT_BACKOFF_BASE_MILLISECONDS;
  const reviewQueueBaseUrl = options?.reviewQueueBaseUrl;
  const clock = options?.clock ?? realWatchdogClock;
  const deliveryPolicy = webhookDeliveryPolicy(maxAttempts, backoffBaseMilliseconds);

  // Subject ids already notified this process, so a delivery is kicked off
  // at most once per (subject, target) pair even across multiple qualifying
  // actions for the same run (e.g. several `step.completed` actions after
  // the same tool-approval review appears). Backed by the KV store when
  // available, so a restart does not re-notify a subject that was already
  // delivered/exhausted/kicked-off by a previous process.
  // Claimed synchronously (no `await` between the check and the add) so two
  // qualifying actions for the SAME review dispatched back-to-back — e.g. two
  // `step.completed` actions before the first delivery's first `await`
  // resolves — can never both win the claim and double-deliver.
  const notifiedSubjectTargets = new Set<string>();
  function claim(id: string): boolean {
    if (notifiedSubjectTargets.has(id)) return false;
    notifiedSubjectTargets.add(id);
    return true;
  }
  let disposed = false;

  // Every in-flight `deliver()` promise, so `flush()` can await terminal
  // state deterministically (tests) and a caller can drain deliveries before
  // shutdown.
  const activeDeliveries = new Set<Promise<void>>();
  function trackDelivery(promise: Promise<void>): void {
    activeDeliveries.add(promise);
    void promise.finally(() => activeDeliveries.delete(promise));
    // AB-260: layered on top of `activeDeliveries` (never replacing it) —
    // every webhook delivery also registers with the bureau's composed
    // `RuntimeServices.deferred`, so `deferred.drain()` reports it under the
    // stable `'webhook-delivery'` label alongside every other subsystem's
    // fire-and-forget work.
    runtime.deferred.track(promise, 'webhook-delivery');
  }

  // ── AB-220: per-delivery liveness ───────────────────────────────────

  interface TrackedDelivery {
    readonly id: string;
    readonly runId: string;
    readonly watchdog: StallWatchdog;
    readonly startedAt: string;
    readonly deadlineAt: number;
  }

  const trackedDeliveries = new Map<string, TrackedDelivery>();

  function computeDeliverySnapshot(tracked: TrackedDelivery): WebhookDeliveryLivenessSnapshot {
    const assessed = tracked.watchdog.assess();
    const status: LivenessLifecycleStatus = 'running';
    return Object.freeze({
      id: tracked.id,
      kind: 'webhook-delivery',
      parentId: tracked.runId,
      startedAt: tracked.startedAt,
      revision: 0,
      status,
      lastTransitionAt: tracked.startedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: assessed.reachability,
      progress: assessed.progress,
      assessment: deriveDeliveryAssessment(status, assessed.reachability, assessed.progress),
      observedAt: clock.now(),
      missedPulseCount: assessed.missedPulseCount,
      deadline: tracked.deadlineAt,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: assessed.evidence,
    });
  }

  const aggregateStartedAt = new Date().toISOString();
  let aggregateRevision = 0;
  let cachedAggregate: WebhookDeliveryLivenessSnapshot | undefined;
  let cachedAggregateRevision = -1;

  interface AggregateSubscriberRecord {
    readonly observer: (snapshot: WebhookDeliveryLivenessSnapshot) => void;
    closed: boolean;
    detachAbortListener: () => void;
  }

  const aggregateSubscribers = new Set<AggregateSubscriberRecord>();

  function computeAggregateSnapshot(): WebhookDeliveryLivenessSnapshot {
    const items = [...trackedDeliveries.values()].map(computeDeliverySnapshot);
    const status: LivenessLifecycleStatus = 'running';
    const reachability = worstReachability(items.map((item) => item.reachability));
    const progress = worstProgress(items.map((item) => item.progress));
    return Object.freeze({
      id: AGGREGATE_DELIVERY_ID,
      kind: 'webhook-delivery',
      startedAt: aggregateStartedAt,
      revision: aggregateRevision,
      status,
      lastTransitionAt: aggregateStartedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability,
      progress,
      assessment: worstAssessment(items.map((item) => item.assessment)),
      observedAt: clock.now(),
      missedPulseCount: items.reduce((max, item) => Math.max(max, item.missedPulseCount), 0),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
  }

  function readAggregateSnapshot(): WebhookDeliveryLivenessSnapshot {
    if (cachedAggregate && cachedAggregateRevision === aggregateRevision) {
      return cachedAggregate;
    }
    cachedAggregate = computeAggregateSnapshot();
    cachedAggregateRevision = aggregateRevision;
    return cachedAggregate;
  }

  function notifyAggregate(): void {
    const current = readAggregateSnapshot();
    for (const record of [...aggregateSubscribers]) {
      if (record.closed) continue;
      try {
        record.observer(current);
      } catch {
        // A throwing subscriber must not escape into the caller driving this
        // revision, matching `active-run-liveness.ts`'s own isolation.
      }
    }
  }

  function advanceAggregate(): void {
    aggregateRevision += 1;
    notifyAggregate();
  }

  function beginTrackedDelivery(id: string, runId: string): TrackedDelivery {
    const watchdog = createStallWatchdog(deliveryPolicy, clock);
    const deadlineAt = clock.now() + (deliveryPolicy.absoluteDeadlineMs ?? 0);
    const tracked: TrackedDelivery = {
      id,
      runId,
      watchdog,
      startedAt: new Date().toISOString(),
      deadlineAt,
    };
    trackedDeliveries.set(id, tracked);
    advanceAggregate();
    return tracked;
  }

  function endTrackedDelivery(tracked: TrackedDelivery): void {
    tracked.watchdog.dispose();
    trackedDeliveries.delete(tracked.id);
    advanceAggregate();
  }

  // Internal shutdown signal, aborted by `dispose()`. Separate from the
  // owner-issued `signal` (AB-37/AB-206): `dispose()` must abandon an
  // in-flight backoff wait even when the caller never configured `signal`,
  // per this module's docstring. Combined with the owner-issued `signal` (if
  // any) so a delivery's backoff `sleep()` is abandoned by EITHER: a call to
  // `dispose()`, or the owner aborting `signal` directly without disposing.
  const shutdownController = new AbortController();
  const backoffAbortSignal = signal
    ? AbortSignal.any([shutdownController.signal, signal])
    : shutdownController.signal;

  // Races the (possibly injected, non-cancellable) `sleep()` against
  // `backoffAbortSignal`, resolving as soon as either settles rather than
  // blocking a `dispose()`/`flush()` caller for the full backoff duration.
  function abandonableSleep(milliseconds: number): Promise<void> {
    if (backoffAbortSignal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      backoffAbortSignal.addEventListener('abort', onAbort, { once: true });
      const finish = () => {
        if (settled) return;
        settled = true;
        backoffAbortSignal.removeEventListener('abort', onAbort);
        resolve();
      };
      // Settled on EITHER outcome of the injected `sleep()`: before this
      // change a rejecting `sleep()` propagated out of `deliver()` into
      // `Promise.allSettled` in `flush()`/`dispose()`; a `.then(finish)`-only
      // handler would instead leave this wait (and the abort listener)
      // hanging forever on a rejection, since neither outcome would ever
      // call `resolve()`.
      void sleep(milliseconds).then(finish, finish);
    });
  }

  async function persist(record: WebhookDeliveryRecord): Promise<void> {
    if (!kv) return;
    try {
      await kv.set(encodeKey(record.id), JSON.stringify(record));
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'webhook',
        message: `[webhook-notifier] Failed to persist delivery "${record.id}":`,
        cause: error,
      });
    }
  }

  async function markExhausted(record: WebhookDeliveryRecord): Promise<void> {
    await auditTrail?.record({
      runId: record.runId,
      type: 'webhook.delivery.exhausted',
      detail: {
        deliveryId: record.id,
        triggerType: record.triggerType,
        targetUrl: record.targetUrl,
        attempts: record.attempts,
        lastError: record.lastError,
      },
    });
  }

  async function deliver(
    subjectId: string,
    target: WebhookTarget,
    targetIndex: number,
    payload: WebhookPayload,
  ): Promise<void> {
    const id = `${subjectId}:${targetIndex}`;
    // Cross-restart dedupe: a previous process may have already claimed (and
    // possibly delivered/exhausted) this subject/target before this process's
    // in-memory `notifiedSubjectTargets` existed.
    if (kv && (await kv.has(encodeKey(id)))) return;

    const createdAt = now();
    let record: WebhookDeliveryRecord = {
      id,
      triggerType: payload.trigger,
      targetUrl: target.url,
      runId: payload.runId,
      status: 'pending',
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await persist(record);

    const tracked = beginTrackedDelivery(id, payload.runId);
    try {
      // Deliberately NOT `&& !disposed` here: the abort check inside the loop
      // body below must run even when `dispose()` has already flipped
      // `disposed` before this delivery's first attempt begins (e.g. dispose
      // races the initial KV lookup/persist above), so an owner-issued
      // `signal` abort is always recorded as `aborted` rather than silently
      // dropped as `pending` — see the abort-before-disposed ordering below.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
          record = { ...record, status: 'aborted', updatedAt: now() };
          await persist(record);
          return;
        }

        // Checked AFTER the abort branch above: a plain `dispose()` with no
        // `signal` configured must still stop the retry loop promptly (the
        // pre-existing behavior), it just has no defined terminal status to
        // persist — the record is left `pending` for a future process to
        // retry, exactly as before this change.
        if (disposed) return;

        record = { ...record, attempts: attempt, updatedAt: now() };
        try {
          const response = await fetchImpl(target.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
          });
          if (!response.ok) {
            throw new Error(`Webhook target responded with status ${response.status}`);
          }
          record = { ...record, status: 'delivered', updatedAt: now() };
          await persist(record);
          return;
        } catch (error) {
          if (signal?.aborted) {
            // The signal aborted mid-attempt (`fetchImpl` observed it, per
            // AB-37/AB-206) — record a defined terminal status rather than
            // treating the abort as a retryable delivery error.
            const lastError = error instanceof Error ? error.message : String(error);
            record = { ...record, status: 'aborted', lastError, updatedAt: now() };
            await persist(record);
            return;
          }

          const lastError = error instanceof Error ? error.message : String(error);
          record = { ...record, lastError, updatedAt: now() };

          if (attempt >= maxAttempts) {
            record = { ...record, status: 'exhausted', updatedAt: now() };
            await persist(record);
            await markExhausted(record);
            return;
          }

          await persist(record);
          const backoffMilliseconds = backoffBaseMilliseconds * 2 ** (attempt - 1);
          await abandonableSleep(backoffMilliseconds);
        }
      }
    } finally {
      endTrackedDelivery(tracked);
    }
  }

  function fireReview(review: PendingReview): void {
    const trigger = reviewTriggerType(review.kind);
    const eligibleTargets = targetsFor(targets, trigger);
    if (eligibleTargets.length === 0) return;

    const payload: WebhookPayload = {
      trigger,
      runId: review.runId,
      reviewId: review.id,
      deepLink: reviewDeepLink(review.id, reviewQueueBaseUrl),
      prompt: review.kind === 'human-wait' ? review.prompt : undefined,
      requestedAt: review.requestedAt,
    };

    for (const target of eligibleTargets) {
      const targetIndex = targets.indexOf(target);
      if (!claim(`${review.id}:${targetIndex}`)) continue;
      trackDelivery(deliver(review.id, target, targetIndex, payload));
    }
  }

  function fireElicitation(action: ActionEvent['action']): void {
    const trigger: WebhookTriggerType = 'elicitation.requested';
    const eligibleTargets = targetsFor(targets, trigger);
    if (eligibleTargets.length === 0) return;

    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : undefined;
    const message = typeof detail?.['message'] === 'string' ? detail['message'] : undefined;

    const subjectId = `elicitation:${action.runId}:${action.sequence}`;
    const payload: WebhookPayload = {
      trigger,
      runId: action.runId,
      deepLink: runDeepLink(action.runId, reviewQueueBaseUrl),
      message,
      requestedAt: action.timestamp,
    };

    for (const target of eligibleTargets) {
      const targetIndex = targets.indexOf(target);
      if (!claim(`${subjectId}:${targetIndex}`)) continue;
      trackDelivery(deliver(subjectId, target, targetIndex, payload));
    }
  }

  function notifyExternal(input: {
    runId: string;
    subjectId: string;
    trigger: WebhookTriggerType;
    detail?: Record<string, unknown>;
  }): void {
    const eligibleTargets = targetsFor(targets, input.trigger);
    if (eligibleTargets.length === 0) return;

    const payload: WebhookPayload = {
      trigger: input.trigger,
      runId: input.runId,
      deepLink: runDeepLink(input.runId, reviewQueueBaseUrl),
      requestedAt: now(),
      detail: input.detail,
    };

    for (const target of eligibleTargets) {
      const targetIndex = targets.indexOf(target);
      if (!claim(`${input.subjectId}:${targetIndex}`)) continue;
      trackDelivery(deliver(input.subjectId, target, targetIndex, payload));
    }
  }

  const listener = (event: ActionEvent) => {
    const { action } = event;
    if (action.type === 'elicitation.requested') {
      fireElicitation(action);
      return;
    }
    if (action.type === 'step.completed' || action.type === 'multiagent.human-wait.parked') {
      for (const review of bureau.listPendingReviews()) {
        if (review.runId !== action.runId) continue;
        fireReview(review);
      }
    }
  };

  bureau.addEventListener('action', listener);

  return {
    async listDeliveries(): Promise<WebhookDeliveryRecord[]> {
      if (!kv) return [];
      const keys = await kv.list(PREFIX);
      const records: WebhookDeliveryRecord[] = [];
      for (const key of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;
        try {
          records.push(JSON.parse(raw) as WebhookDeliveryRecord);
        } catch {
          // Skip a corrupt record rather than fail the whole listing.
        }
      }
      return records;
    },
    async flush(): Promise<void> {
      await Promise.allSettled([...activeDeliveries]);
    },
    notify: notifyExternal,
    async dispose(): Promise<void> {
      disposed = true;
      shutdownController.abort();
      bureau.removeEventListener('action', listener);
      await Promise.allSettled([...activeDeliveries]);
    },
    activeDeliverySnapshots(): WebhookDeliveryLivenessSnapshot[] {
      return [...trackedDeliveries.values()].map(computeDeliverySnapshot);
    },
    snapshot(): WebhookDeliveryLivenessSnapshot {
      return readAggregateSnapshot();
    },
    subscribeSnapshot(
      observer: (snapshot: WebhookDeliveryLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      const subscriptionSignal = subscribeOptions?.signal;
      const record: AggregateSubscriberRecord = {
        observer,
        closed: false,
        detachAbortListener: () => subscriptionSignal?.removeEventListener('abort', unsubscribe),
      };

      function unsubscribe(): void {
        if (record.closed) return;
        record.closed = true;
        record.detachAbortListener();
        aggregateSubscribers.delete(record);
      }

      if (subscriptionSignal?.aborted) {
        record.closed = true;
        try {
          observer(readAggregateSnapshot());
        } catch {
          // Same isolation as `notifyAggregate()` above.
        }
        return {
          unsubscribe,
          get closed() {
            return record.closed;
          },
        };
      }

      aggregateSubscribers.add(record);
      subscriptionSignal?.addEventListener('abort', unsubscribe, { once: true });

      try {
        observer(readAggregateSnapshot());
      } catch {
        // Same isolation as `notifyAggregate()` above.
      }

      return {
        unsubscribe,
        get closed() {
          return record.closed;
        },
      };
    },
  };
}
