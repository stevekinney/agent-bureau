/**
 * Tests for `createWebhookNotifier` (AB-21).
 *
 * Uses a hand-crafted `Bureau` stub — same pattern as `audit-trail.test.ts` —
 * so tests are fully deterministic without starting a live bureau or durable
 * engine. `fetch`, `sleep`, and `now` are all injected so retry/backoff
 * behavior never touches a real timer or the network.
 */
import type { StallWatchdogClock } from '@lostgradient/operative/liveness';
import type { Action } from '@lostgradient/operative/store';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { AuditTrail } from './audit-trail';
import { ActionEvent } from './events';
import type { Bureau, PendingReview } from './types';
import {
  computeWebhookDeliveryDeadlineMs,
  createWebhookNotifier,
  realWatchdogClock,
  type WebhookDeliveryRecord,
  worstAssessment,
  worstProgress,
  worstReachability,
} from './webhook-notifier';

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
    async dispose() {},
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

/** A timer-agnostic manual clock (AB-220) — no real timers, `setTimeout`/`clearTimeout` unused by a no-cadence policy. */
function manualClock(start = 0): StallWatchdogClock & { advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    setTimeout: () => 0,
    clearTimeout: () => {},
    advance(ms: number) {
      time += ms;
    },
  };
}

/**
 * A `fetchImpl` whose returned promise never resolves on its own — standing
 * in for a single hung request (AB-220). Resolves `started` once the call
 * has been made, so a test can synchronize before advancing a manual clock.
 * Rejects if `init.signal` aborts, so `notifier.dispose()` can still clean
 * it up.
 */
function hangingFetch(): { fetch: typeof fetch; started: Promise<void> } {
  let resolveStarted: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    resolveStarted();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, started };
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
    await notifier.dispose();
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

    await notifier.dispose();
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

    await notifier.dispose();
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

    await notifier.dispose();
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

    await notifier.dispose();
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

    await notifier.dispose();
  });

  describe('onDiagnostic', () => {
    afterEach(() => {
      (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    /** A `TextValueStore`-shaped stub whose `set` always rejects. */
    function createFailingKv(): ReturnType<typeof textValueStore> {
      const kv = textValueStore(new MemoryStorage());
      return {
        ...kv,
        set: async () => {
          throw new Error('disk full');
        },
      };
    }

    it('routes a delivery-persistence failure to the diagnostic sink instead of the console', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const review = makeToolApprovalReview();
      const { bureau, emit } = createStubBureau([review]);
      const kv = createFailingKv();
      const { fetch: fetchImpl } = okFetch();
      const received: unknown[] = [];
      const notifier = createWebhookNotifier(
        bureau,
        kv,
        undefined,
        { targets: [{ url: 'https://example.com/hook' }], fetch: fetchImpl },
        (diagnostic) => received.push(diagnostic),
      );

      emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
      await notifier.flush();

      // `persist()` is called once per delivery-state transition (e.g.
      // pending → delivered), so a permanently-failing kv can surface more
      // than one diagnostic for a single delivery — assert on their shape,
      // not an exact count.
      expect(received.length).toBeGreaterThan(0);
      for (const diagnostic of received) {
        expect(diagnostic).toMatchObject({ level: 'error', scope: 'webhook' });
      }
      expect(errorSpy).not.toHaveBeenCalled();

      await notifier.dispose();
    });

    it('with no sink configured, a delivery-persistence failure still logs to the console', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const review = makeToolApprovalReview();
      const { bureau, emit } = createStubBureau([review]);
      const kv = createFailingKv();
      const { fetch: fetchImpl } = okFetch();
      const notifier = createWebhookNotifier(bureau, kv, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
      });

      emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
      await notifier.flush();

      expect(errorSpy).toHaveBeenCalled();

      await notifier.dispose();
    });
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

    await notifier.dispose();
  });

  it('uses the non-blocking default timer when no sleep implementation is injected', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response(null, { status: attempts === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      maxAttempts: 2,
      backoffBaseMilliseconds: 0,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(attempts).toBe(2);
    await notifier.dispose();
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

    await notifier.dispose();
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

    await notifier.dispose();
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

  it('dispose() abandons an in-flight backoff wait instead of hanging until it elapses', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    // A `sleep()` that never resolves on its own — standing in for a very
    // long backoff wait. If `dispose()` merely awaited this promise, it
    // would hang forever; it must instead abandon the wait via the internal
    // shutdown signal (AB-37/AB-206).
    const sleep = () => new Promise<void>(() => {});

    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      sleep,
      maxAttempts: 5,
      backoffBaseMilliseconds: 10,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));

    // Give the first attempt's microtasks a chance to run: it fails and
    // parks in the never-resolving backoff wait. `flush()` would hang here
    // too (nothing has aborted the wait yet), so poll callCount directly
    // instead of awaiting it.
    while (callCount === 0) {
      await Promise.resolve();
    }
    expect(callCount).toBe(1);

    let disposeResolved = false;
    const disposePromise = notifier.dispose().then(() => {
      disposeResolved = true;
    });
    await disposePromise;

    expect(disposeResolved).toBe(true);
    // dispose() abandoned the wait before the retry fired.
    expect(callCount).toBe(1);
  });

  // ── Awaitable dispose() and AbortSignal threading (AB-37/AB-206) ────

  it('dispose() returns a promise that resolves only after every in-flight deliver() settles', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);

    let releaseFetch: (() => void) | undefined;
    const fetchImpl = (() =>
      new Promise<Response>((resolve) => {
        releaseFetch = () => resolve(new Response(null, { status: 200 }));
      })) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));

    let disposeResolved = false;
    const disposePromise = notifier.dispose().then(() => {
      disposeResolved = true;
    });

    // Give the gated fetch's microtasks a chance to run: dispose() must
    // still be pending because the fetch has not resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(disposeResolved).toBe(false);

    releaseFetch?.();
    await disposePromise;

    expect(disposeResolved).toBe(true);
  });

  it('threads the owner-issued AbortSignal into fetchImpl on every attempt', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const controller = new AbortController();

    const observedSignals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observedSignals.push(init?.signal);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      signal: controller.signal,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(observedSignals).toEqual([controller.signal]);
    await notifier.dispose();
  });

  it('aborting the signal mid-delivery records the delivery as aborted rather than pending, and stops retrying', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const kv = textValueStore(new MemoryStorage());
    const controller = new AbortController();

    let callCount = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      callCount++;
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new Error('shutting down'));
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, kv, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      maxAttempts: 5,
      backoffBaseMilliseconds: 10,
      signal: controller.signal,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(callCount).toBe(1);
    const deliveries = await notifier.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe('aborted');
    expect(deliveries[0]?.status).not.toBe('pending');

    await notifier.dispose();
  });

  it('an already-aborted signal at delivery start records the delivery as aborted without attempting fetchImpl', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const kv = textValueStore(new MemoryStorage());
    const controller = new AbortController();
    controller.abort(new Error('shutting down before delivery started'));

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, kv, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      signal: controller.signal,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));
    await notifier.flush();

    expect(callCount).toBe(0);
    const deliveries = await notifier.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe('aborted');

    await notifier.dispose();
  });

  it('aborting the signal and calling dispose() while the initial pending persist is in flight still records aborted, not pending', async () => {
    const review = makeToolApprovalReview();
    const { bureau, emit } = createStubBureau([review]);
    const controller = new AbortController();

    // Gates the delivery's INITIAL `pending`-status `kv.set()` (the one
    // `deliver()` awaits before the retry loop even starts), so `dispose()`
    // can race it: `disposed` becomes true before the loop's first
    // iteration begins, and the abort branch inside the loop body must
    // still win over the `disposed` short-circuit rather than leaving the
    // record `pending` forever.
    const baseKv = textValueStore(new MemoryStorage());
    let releaseInitialSet: (() => void) | undefined;
    let initialSetGated = false;
    const kv: ReturnType<typeof textValueStore> = {
      ...baseKv,
      set: async (key, value) => {
        if (!initialSetGated) {
          initialSetGated = true;
          await new Promise<void>((resolve) => {
            releaseInitialSet = resolve;
          });
        }
        await baseKv.set(key, value);
      },
    };

    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const notifier = createWebhookNotifier(bureau, kv, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
      signal: controller.signal,
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1' }));

    // Give `deliver()` a chance to reach the gated initial persist.
    while (!releaseInitialSet) {
      await Promise.resolve();
    }

    controller.abort(new Error('shutting down mid initial persist'));
    const disposePromise = notifier.dispose();
    releaseInitialSet();
    await disposePromise;

    const deliveries = await notifier.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe('aborted');
    expect(deliveries[0]?.status).not.toBe('pending');
  });

  it('calling dispose() twice does not throw', async () => {
    const { bureau } = createStubBureau();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, { targets: [] });

    const firstDispose = await notifier.dispose();
    expect(firstDispose).toBeUndefined();
    const secondDispose = await notifier.dispose();
    expect(secondDispose).toBeUndefined();
  });

  it('calling dispose() twice on a configured notifier does not throw and the second call resolves promptly', async () => {
    const { bureau } = createStubBureau();
    const { fetch: fetchImpl } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    const firstDispose = await notifier.dispose();
    expect(firstDispose).toBeUndefined();
    const secondDispose = await notifier.dispose();
    expect(secondDispose).toBeUndefined();
  });

  // ── notify() — out-of-band delivery (AB-53) ─────────────────────────

  it('notify() delivers to targets subscribed to the given trigger, deep-linked to the run', async () => {
    const { bureau } = createStubBureau();
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook', events: ['eval.threshold-breached'] }],
      fetch: fetchImpl,
      reviewQueueBaseUrl: 'https://gateway.example.com',
    });

    notifier.notify({
      runId: 'run-1',
      subjectId: 'eval:run-1:quality-judge',
      trigger: 'eval.threshold-breached',
      detail: { judgeName: 'quality-judge', score: 0.2, threshold: 0.5 },
    });
    await notifier.flush();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({
      trigger: 'eval.threshold-breached',
      runId: 'run-1',
      deepLink: 'https://gateway.example.com/runs/run-1',
      detail: { judgeName: 'quality-judge', score: 0.2, threshold: 0.5 },
    });

    await notifier.dispose();
  });

  it('notify() does not deliver to a target not subscribed to the given trigger', async () => {
    const { bureau } = createStubBureau();
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/approvals-only', events: ['approval-pending'] }],
      fetch: fetchImpl,
    });

    notifier.notify({
      runId: 'run-1',
      subjectId: 'eval:run-1:quality-judge',
      trigger: 'eval.threshold-breached',
    });
    await notifier.flush();

    expect(calls).toHaveLength(0);

    await notifier.dispose();
  });

  it('notify() dedupes by subjectId + target, same as the action-stream triggers', async () => {
    const { bureau } = createStubBureau();
    const { fetch: fetchImpl, calls } = okFetch();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, {
      targets: [{ url: 'https://example.com/hook' }],
      fetch: fetchImpl,
    });

    notifier.notify({
      runId: 'run-1',
      subjectId: 'eval:run-1:judge-a',
      trigger: 'eval.threshold-breached',
    });
    notifier.notify({
      runId: 'run-1',
      subjectId: 'eval:run-1:judge-a',
      trigger: 'eval.threshold-breached',
    });
    await notifier.flush();

    expect(calls).toHaveLength(1);

    await notifier.dispose();
  });

  it('notify() is a no-op on the no-targets notifier', async () => {
    const { bureau } = createStubBureau();
    const notifier = createWebhookNotifier(bureau, undefined, undefined, { targets: [] });
    notifier.notify({
      runId: 'run-1',
      subjectId: 'eval:run-1:judge-a',
      trigger: 'eval.threshold-breached',
    });
    await notifier.flush();
    await notifier.dispose();
  });

  // ── AB-220: per-delivery liveness ───────────────────────────────────

  describe('computeWebhookDeliveryDeadlineMs (AB-220)', () => {
    it('computes the default 15000ms deadline from DEFAULT_MAX_ATTEMPTS/DEFAULT_BACKOFF_BASE_MILLISECONDS', () => {
      // backoffBaseMilliseconds * (2 ** (maxAttempts - 1) - 1) = 1000 * (2**4 - 1) = 15000.
      expect(computeWebhookDeliveryDeadlineMs(5, 1000)).toBe(15000);
    });

    it('computes the deadline for a caller-configured maxAttempts/backoffBaseMilliseconds override', () => {
      // 2000 * (2**2 - 1) = 6000.
      expect(computeWebhookDeliveryDeadlineMs(3, 2000)).toBe(6000);
    });

    it('computes 0 for a single-attempt delivery (no retries to sum)', () => {
      expect(computeWebhookDeliveryDeadlineMs(1, 1000)).toBe(0);
    });
  });

  describe('per-delivery liveness (AB-220)', () => {
    it('a tracked delivery reports kind "webhook-delivery", the current policy version, and the computed deadline', async () => {
      const { bureau, emit } = createStubBureau();
      const { fetch: fetchImpl, started } = hangingFetch();
      const clock = manualClock();
      const controller = new AbortController();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock,
        signal: controller.signal,
      });

      emit(
        makeAction({
          type: 'elicitation.requested',
          runId: 'run-1',
          sequence: 1,
          detail: { message: 'confirm?' },
        }),
      );
      await started;

      const [snapshot] = notifier.activeDeliverySnapshots();
      expect(snapshot?.kind).toBe('webhook-delivery');
      expect(snapshot?.status).toBe('running');
      expect(snapshot?.deadline).toBe(computeWebhookDeliveryDeadlineMs(5, 1000));

      controller.abort(new Error('test teardown'));
      await notifier.dispose();
    });

    it('a delivery whose fetchImpl hangs past the computed deadline classifies unreachable', async () => {
      const { bureau, emit } = createStubBureau();
      const { fetch: fetchImpl, started } = hangingFetch();
      const clock = manualClock();
      const controller = new AbortController();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock,
        signal: controller.signal,
      });

      emit(
        makeAction({
          type: 'elicitation.requested',
          runId: 'run-1',
          sequence: 1,
          detail: { message: 'confirm?' },
        }),
      );
      await started;

      // Before the deadline: no activity pulse was ever recorded (this
      // policy row has no cadence), so reachability/progress read 'unknown'
      // and the derived assessment is 'healthy'.
      expect(notifier.activeDeliverySnapshots()[0]?.assessment).toBe('healthy');

      clock.advance(computeWebhookDeliveryDeadlineMs(5, 1000) + 1);

      const [snapshot] = notifier.activeDeliverySnapshots();
      expect(snapshot?.reachability).toBe('unreachable');
      expect(snapshot?.progress).toBe('stalled');
      expect(snapshot?.assessment).toBe('unreachable');

      controller.abort(new Error('test teardown'));
      await notifier.dispose();
    });

    it('removes a delivery from activeDeliverySnapshots() once it reaches a terminal outcome', async () => {
      const { bureau, emit } = createStubBureau();
      const { fetch: fetchImpl } = okFetch();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock: manualClock(),
      });

      emit(
        makeAction({
          type: 'elicitation.requested',
          runId: 'run-1',
          sequence: 1,
          detail: { message: 'confirm?' },
        }),
      );
      await notifier.flush();

      expect(notifier.activeDeliverySnapshots()).toHaveLength(0);
      await notifier.dispose();
    });

    it('snapshot() reports the instance-level aggregate as healthy with no active deliveries', async () => {
      const { bureau } = createStubBureau();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        clock: manualClock(),
      });

      expect(notifier.snapshot().assessment).toBe('healthy');
      expect(notifier.snapshot().kind).toBe('webhook-delivery');
      await notifier.dispose();
    });

    it('subscribeSnapshot() delivers the current aggregate immediately, then again as a delivery starts and finishes', async () => {
      const { bureau, emit } = createStubBureau();
      const { fetch: fetchImpl } = okFetch();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock: manualClock(),
      });

      const revisions: number[] = [];
      const subscription = notifier.subscribeSnapshot((snapshot) => {
        revisions.push(snapshot.revision);
      });
      expect(revisions).toEqual([0]);

      emit(
        makeAction({
          type: 'elicitation.requested',
          runId: 'run-1',
          sequence: 1,
          detail: { message: 'confirm?' },
        }),
      );
      await notifier.flush();

      expect(revisions.length).toBeGreaterThanOrEqual(3);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));

      subscription.unsubscribe();
      await notifier.dispose();
    });

    it('subscribeSnapshot() stops delivering after unsubscribe()', async () => {
      const { bureau, emit } = createStubBureau();
      const { fetch: fetchImpl } = okFetch();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock: manualClock(),
      });

      let calls = 0;
      const subscription = notifier.subscribeSnapshot(() => {
        calls++;
      });
      expect(calls).toBe(1);
      subscription.unsubscribe();
      expect(subscription.closed).toBe(true);

      emit(
        makeAction({
          type: 'elicitation.requested',
          runId: 'run-1',
          sequence: 1,
          detail: { message: 'confirm?' },
        }),
      );
      await notifier.flush();

      expect(calls).toBe(1);
      await notifier.dispose();
    });

    it('subscribeSnapshot() with an already-aborted signal delivers once, synchronously closed', async () => {
      const { bureau } = createStubBureau();
      const { fetch: fetchImpl } = okFetch();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, {
        targets: [{ url: 'https://example.com/hook' }],
        fetch: fetchImpl,
        clock: manualClock(),
      });

      const controller = new AbortController();
      controller.abort();

      let calls = 0;
      const subscription = notifier.subscribeSnapshot(() => calls++, {
        signal: controller.signal,
      });

      expect(calls).toBe(1);
      expect(subscription.closed).toBe(true);
      await notifier.dispose();
    });

    it('the no-op notifier (no targets) reports a terminal aggregate snapshot and no active deliveries', async () => {
      const { bureau } = createStubBureau();
      const notifier = createWebhookNotifier(bureau, undefined, undefined, { targets: [] });

      expect(notifier.activeDeliverySnapshots()).toEqual([]);
      expect(notifier.snapshot().status).toBe('terminal');
      expect(notifier.snapshot().assessment).toBe('terminal');

      let observed: unknown;
      const subscription = notifier.subscribeSnapshot((snapshot) => {
        observed = snapshot;
      });
      expect(observed).toBe(notifier.snapshot());
      expect(subscription.closed).toBe(true);
      subscription.unsubscribe();

      await notifier.dispose();
    });
  });

  describe('the default production clock (AB-220)', () => {
    it('now() reads performance.now()', () => {
      expect(typeof realWatchdogClock.now()).toBe('number');
    });

    it('setTimeout()/clearTimeout() delegate to the global timer functions', () => {
      const timeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const callback = () => {};
        const handle = realWatchdogClock.setTimeout(callback, 5);
        expect(timeoutSpy).toHaveBeenCalledWith(callback, 5);
        realWatchdogClock.clearTimeout(handle);
        expect(clearSpy).toHaveBeenCalledWith(handle);
      } finally {
        timeoutSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });
  });

  describe('worstAssessment/worstReachability/worstProgress (AB-220)', () => {
    it('worstAssessment returns "healthy" for an empty or all-healthy set', () => {
      expect(worstAssessment([])).toBe('healthy');
      expect(worstAssessment(['healthy', 'healthy'])).toBe('healthy');
    });

    it('worstAssessment picks the most severe non-terminal assessment, skipping terminal entries', () => {
      expect(worstAssessment(['healthy', 'alive-but-stalled', 'legitimately-waiting'])).toBe(
        'alive-but-stalled',
      );
      expect(worstAssessment(['terminal', 'unreachable', 'healthy'])).toBe('unreachable');
    });

    it('worstReachability returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstReachability([])).toBe('unknown');
      expect(worstReachability(['reachable', 'unreachable', 'late'])).toBe('unreachable');
    });

    it('worstProgress returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstProgress([])).toBe('unknown');
      expect(worstProgress(['progressing', 'stalled', 'idle'])).toBe('stalled');
    });
  });
});
