/**
 * Tests for `createWebhookNotifier` (AB-21).
 *
 * Uses a hand-crafted `Bureau` stub — same pattern as `audit-trail.test.ts` —
 * so tests are fully deterministic without starting a live bureau or durable
 * engine. `fetch`, `sleep`, and `now` are all injected so retry/backoff
 * behavior never touches a real timer or the network.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import type { Action } from 'operative/store';

import type { AuditTrail } from './audit-trail';
import { ActionEvent } from './events';
import type { Bureau, PendingReview } from './types';
import { createWebhookNotifier, type WebhookDeliveryRecord } from './webhook-notifier';

// ── Minimal Bureau stub ──────────────────────────────────────────────

type ActionListener = (event: ActionEvent) => void;

function createStubBureau(pendingReviews: PendingReview[] = []): {
  bureau: Bureau;
  emit: (action: Action) => void;
  setPendingReviews: (reviews: PendingReview[]) => void;
} {
  const listeners = new Set<ActionListener>();
  let reviews = pendingReviews;

  const bureau = {
    addEventListener(_type: string, listener: ActionListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: ActionListener) {
      listeners.delete(listener);
    },
    listPendingReviews(): PendingReview[] {
      return reviews;
    },
  } as unknown as Bureau;

  const emit = (action: Action) => {
    const event = new ActionEvent(action);
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    bureau,
    emit,
    setPendingReviews: (next: PendingReview[]) => {
      reviews = next;
    },
  };
}

function makeAction(overrides: Partial<Action> & { type: string; runId: string }): Action {
  return {
    sequence: 1,
    detail: null,
    timestamp: 1_000,
    ...overrides,
  };
}

function makeToolApprovalReview(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    kind: 'tool-approval',
    id: 'approval:run-1:call-1',
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: 'agent-1',
    approval: {
      callId: 'call-1',
      toolName: 'refund',
      arguments: {},
    } as never,
    requestedAt: 1_000,
    ageMilliseconds: 0,
    ...overrides,
  } as PendingReview;
}

function makeHumanWaitReview(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    kind: 'human-wait',
    id: 'human-wait:run-1:human-response',
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: 'agent-1',
    signalName: 'human-response',
    prompt: 'Approve refund?',
    requestedAt: 1_000,
    ageMilliseconds: 0,
    ...overrides,
  } as PendingReview;
}

function createStubAuditTrail(): { auditTrail: AuditTrail; records: unknown[] } {
  const records: unknown[] = [];
  const auditTrail: AuditTrail = {
    async record(entry) {
      records.push(entry);
    },
    async query() {
      return [];
    },
    dispose() {},
  };
  return { auditTrail, records };
}

interface RecordedFetchCall {
  url: string;
  body: string;
}

/** Fetch stub: resolves `{ ok: true }` immediately, records every call. */
function okFetch(): { fetch: typeof fetch; calls: RecordedFetchCall[] } {
  const calls: RecordedFetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Immediate sleep stub that records the requested backoff durations. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    waits,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createWebhookNotifier', () => {
  it('is a no-op when no targets are configured', async () => {
    const { bureau } = createStubBureau();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, { targets: [] });
    expect(await notifier.listDeliveries()).toEqual([]);
    await notifier.flush();
    notifier.dispose();
  });

  it('fires elicitation.requested with a run deep link', async () => {
    const { bureau, emit } = createStubBureau();
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    emit(
      makeAction({
        type: 'elicitation.requested',
        runId: 'run-1',
        sequence: 7,
        timestamp: 5_000,
        detail: { step: 0, message: 'Do you confirm?' },
      }),
    );
    await notifier.flush();

    expect(calls).toHaveLength(1);
    const { url, body: rawBody } = calls[0]!;
    expect(url).toBe('https://example.com/hook');
    const body = JSON.parse(rawBody);
    expect(body).toMatchObject({
      trigger: 'elicitation.requested',
      runId: 'run-1',
      deepLink: '/runs/run-1',
      message: 'Do you confirm?',
    });

    notifier.dispose();
  });

  it('fires approval-pending with a review-queue deep link for a new tool-approval review', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({
      trigger: 'approval-pending',
      runId: 'run-1',
      reviewId: review.id,
      deepLink: `/reviews?id=${encodeURIComponent(review.id)}`,
    });

    // A second `step.completed` for the SAME still-pending review must not
    // re-fire the webhook.
    emit(makeAction({ type: 'step.completed', runId: 'run-1', sequence: 2 }));
    await notifier.flush();
    expect(calls).toHaveLength(1);

    notifier.dispose();
  });

  it('fires human-wait.parked with a review-queue deep link for a new human-wait review', async () => {
    const review = makeHumanWaitReview();
    const { bureau, emit } = createStubBureau([review]);
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    emit(makeAction({ type: 'multiagent.human-wait.parked', runId: 'run-1' }));
    await notifier.flush();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({
      trigger: 'human-wait.parked',
      runId: 'run-1',
      reviewId: review.id,
      deepLink: `/reviews?id=${encodeURIComponent(review.id)}`,
      prompt: 'Approve refund?',
    });

    notifier.dispose();
  });

  it('only notifies targets subscribed to the firing trigger type', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [
        { url: 'https://example.com/approvals-only', events: ['approval-pending'] },
        { url: 'https://example.com/human-wait-only', events: ['human-wait.parked'] },
      ],
      fetch: fetchImpl,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.com/approvals-only');

    notifier.dispose();
  });

  it('persists delivery state to the KV store', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const kv = textValueStore(new MemoryStorage());
    const { fetch: fetchImpl } = okFetch();
    const notifier = createWebhookNotifier(bureau, kv, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    const deliveries = await notifier.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      triggerType: 'approval-pending',
      targetUrl: 'https://example.com/hook',
      runId: 'run-1',
      status: 'delivered',
      attempts: 1,
    });

    notifier.dispose();
  });

  it('retries a failing delivery with exponential backoff, then succeeds', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const { sleep, waits } = recordingSleep();

    let callCount = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      callCount++;
      calls.push(url);
      // Fail the first two attempts, succeed on the third.
      if (callCount < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      sleep,
      maxAttempts: 5,
      backoffBaseMilliseconds: 100,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(calls).toHaveLength(3);
    // attempt 1 fails -> sleep(100); attempt 2 fails -> sleep(200); attempt 3 succeeds.
    expect(waits).toEqual([100, 200]);

    notifier.dispose();
  });

  it('surfaces a delivery in the audit trail after exhausting retries (neuter-verified)', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const { sleep } = recordingSleep();
    const { auditTrail, records } = createStubAuditTrail();

    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, undefined, auditTrail, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      sleep,
      maxAttempts: 3,
      backoffBaseMilliseconds: 10,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    const deliveries = await notifier.listDeliveries();
    // No KV configured in this test, so listDeliveries() has nothing to
    // report — the audit trail is the durable surface under test here.
    expect(deliveries).toEqual([]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      type: 'webhook.delivery.exhausted',
      detail: expect.objectContaining({
        triggerType: 'approval-pending',
        attempts: 3,
      }),
    });

    notifier.dispose();
  });

  it('surfaces exhaustion in KV-persisted delivery state too', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const kv = textValueStore(new MemoryStorage());
    const { sleep } = recordingSleep();
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, kv, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      sleep,
      maxAttempts: 2,
      backoffBaseMilliseconds: 10,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    const deliveries: WebhookDeliveryRecord[] = await notifier.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'exhausted', attempts: 2 });
    expect(deliveries[0]?.lastError).toContain('500');

    notifier.dispose();
  });

  it('stops retrying once disposed mid-backoff', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    // A sleep that disposes the notifier mid-wait, simulating a shutdown
    // racing an in-flight backoff. `box` (not `notifier` itself) is mutated
    // so the closure below never needs a reassignable binding.
    const box: { notifier?: ReturnType<typeof createWebhookNotifier> } = {};
    const sleep = async () => {
      box.notifier?.dispose();
    };

    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      sleep,
      maxAttempts: 5,
      backoffBaseMilliseconds: 10,
    });
    box.notifier = notifier;

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    // Attempt 1 fails, dispose() fires inside sleep(), the retry loop's guard
    // (`!disposed`) then stops it from attempting a second time.
    expect(callCount).toBe(1);
  });
});
