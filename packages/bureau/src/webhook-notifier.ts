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
 */
import type { TextValueStore } from '@lostgradient/weft/storage';

import type { AuditTrail } from './audit-trail';
import type { ActionEvent } from './events';
import type { Bureau, PendingReview } from './types';

// ── Public surface ──────────────────────────────────────────────────

/** The three trigger types that fire a configured webhook. */
export type WebhookTriggerType = 'elicitation.requested' | 'approval-pending' | 'human-wait.parked';

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
  /** Injectable backoff sleep. Defaults to a `setTimeout`-backed implementation. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Maximum delivery attempts before a delivery is marked `exhausted`. Default `5`. */
  maxAttempts?: number;
  /** Base backoff delay in milliseconds; doubles on every retry. Default `1000`. */
  backoffBaseMilliseconds?: number;
}

/** The persisted record for a single webhook delivery. */
export interface WebhookDeliveryRecord {
  /** `<subjectId>:<targetIndex>` — stable across retries and restarts. */
  id: string;
  triggerType: WebhookTriggerType;
  targetUrl: string;
  runId: string;
  status: 'pending' | 'delivered' | 'exhausted';
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookNotifier {
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
  /** Stop listening to bureau events and abandon any in-flight backoff waits. */
  dispose(): void;
}

// ── Key encoding ────────────────────────────────────────────────────

const PREFIX = 'webhook-delivery:v1:';

function encodeKey(id: string): string {
  return `${PREFIX}${id}`;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MILLISECONDS = 1000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    // Never keep the process alive purely to finish a webhook backoff wait —
    // matches the "best-effort, never blocks shutdown" posture of the audit
    // trail's fire-and-forget writes.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
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
 */
export function createWebhookNotifier(
  bureau: Bureau,
  kv: TextValueStore | undefined,
  auditTrail: AuditTrail | undefined,
  options: WebhookNotifierOptions | undefined,
): WebhookNotifier {
  const targets = options?.targets ?? [];

  if (targets.length === 0) {
    return {
      listDeliveries() {
        return Promise.resolve([]);
      },
      async flush() {
        // Nothing was ever kicked off.
      },
      dispose() {
        // Nothing was ever subscribed.
      },
    };
  }

  const fetchImpl = options?.fetch ?? fetch;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? Date.now;
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMilliseconds =
    options?.backoffBaseMilliseconds ?? DEFAULT_BACKOFF_BASE_MILLISECONDS;
  const reviewQueueBaseUrl = options?.reviewQueueBaseUrl;

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
  }

  async function persist(record: WebhookDeliveryRecord): Promise<void> {
    if (!kv) return;
    try {
      await kv.set(encodeKey(record.id), JSON.stringify(record));
    } catch (error) {
      console.error(`[webhook-notifier] Failed to persist delivery "${record.id}":`, error);
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

    for (let attempt = 1; attempt <= maxAttempts && !disposed; attempt++) {
      record = { ...record, attempts: attempt, updatedAt: now() };
      try {
        const response = await fetchImpl(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Webhook target responded with status ${response.status}`);
        }
        record = { ...record, status: 'delivered', updatedAt: now() };
        await persist(record);
        return;
      } catch (error) {
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
        await sleep(backoffMilliseconds);
      }
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
    dispose(): void {
      disposed = true;
      bureau.removeEventListener('action', listener);
    },
  };
}
