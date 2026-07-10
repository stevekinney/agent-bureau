import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { PendingHumanWaitReview, PendingToolApprovalReview } from '../../types';
import { createReviewsStore } from './use-reviews.svelte.ts';

function makeToolApproval(
  overrides: Partial<PendingToolApprovalReview> = {},
): PendingToolApprovalReview {
  return {
    kind: 'tool-approval',
    id: 'approval:run-1:call-1',
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: undefined,
    approval: {
      callId: 'call-1',
      toolName: 'delete_file',
      arguments: { path: '/tmp/x' },
      action: { type: 'approval', message: 'Confirm this destructive action' },
      reason: 'Destructive action',
    },
    requestedAt: 0,
    ageMilliseconds: 0,
    ...overrides,
  };
}

function makeHumanWait(overrides: Partial<PendingHumanWaitReview> = {}): PendingHumanWaitReview {
  return {
    kind: 'human-wait',
    id: 'human-wait:run-1:human-response',
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: undefined,
    signalName: 'human-response',
    prompt: 'Approve this?',
    requestedAt: 0,
    ageMilliseconds: 0,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createReviewsStore', () => {
  it('seeds reviews from the initial value', () => {
    const store = createReviewsStore([makeHumanWait()]);
    expect(store.reviews).toHaveLength(1);
    expect(store.loading).toBe(false);
    expect(store.pendingId).toBeUndefined();
    expect(store.error).toBeUndefined();
  });

  it('replaces the review list on refresh', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify([makeHumanWait({ id: 'refreshed' })]))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createReviewsStore([makeHumanWait({ id: 'stale' })]);
    await store.refresh();

    expect(store.reviews.map((review) => review.id)).toEqual(['refreshed']);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reviews');
  });

  it('records an error message when refresh fails', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ message: 'nope' }), { status: 500 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createReviewsStore([]);
    await store.refresh();

    expect(store.error).toBe('nope');
  });

  it('approves a human-wait review with a payload and drops it from the list', async () => {
    const review = makeHumanWait();
    const fetchMock = mock((input: unknown, init?: RequestInit) => {
      expect(input).toBe(`/api/v1/reviews/${encodeURIComponent(review.id)}/approve`);
      expect(JSON.parse(init?.body as string)).toEqual({ payload: { approved: true } });
      return Promise.resolve(
        new Response(JSON.stringify({ id: review.id, kind: 'human-wait', decision: 'approve' })),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createReviewsStore([review]);
    await store.approve(review.id, { payload: { approved: true } });

    expect(store.reviews).toHaveLength(0);
    expect(store.pendingId).toBeUndefined();
    expect(store.error).toBeUndefined();
  });

  it('denies a review with a reason and drops it from the list', async () => {
    const review = makeToolApproval();
    const fetchMock = mock((input: unknown, init?: RequestInit) => {
      expect(input).toBe(`/api/v1/reviews/${encodeURIComponent(review.id)}/deny`);
      expect(JSON.parse(init?.body as string)).toEqual({ reason: 'not safe' });
      return Promise.resolve(
        new Response(JSON.stringify({ id: review.id, kind: 'tool-approval', decision: 'deny' })),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createReviewsStore([review]);
    await store.deny(review.id, { reason: 'not safe' });

    expect(store.reviews).toHaveLength(0);
  });

  it('keeps a review in the list and records an error when resolve fails', async () => {
    const review = makeHumanWait();
    const fetchMock = mock(() => Promise.resolve(new Response('conflict', { status: 409 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const store = createReviewsStore([review]);
    await store.approve(review.id);

    expect(store.reviews).toHaveLength(1);
    expect(store.error).toBe('Request failed with status 409');
  });
});
