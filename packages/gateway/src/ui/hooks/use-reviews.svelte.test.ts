import { describe, expect, it, mock } from 'bun:test';

import type { PendingHumanWaitReview, PendingToolApprovalReview } from '../../types';
import type { GatewayClientEnvironment } from '../client-environment';
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

/**
 * Builds a {@link GatewayClientEnvironment} test double with a controllable
 * `fetch`. `use-reviews.svelte.ts` never touches `WebSocket`, `EventSource`,
 * or `timers`, so those fields throw if a bug ever causes them to be
 * invoked.
 */
function createEnvironment(fetchImplementation: typeof fetch): GatewayClientEnvironment {
  return {
    fetch: fetchImplementation,
    WebSocket: class {
      constructor() {
        throw new Error('use-reviews does not construct a WebSocket');
      }
    } as unknown as typeof WebSocket,
    EventSource: class {
      constructor() {
        throw new Error('use-reviews does not construct an EventSource');
      }
    } as unknown as typeof EventSource,
    timers: {
      setTimeout: () => {
        throw new Error('use-reviews does not use timers.setTimeout');
      },
      clearTimeout: () => {
        throw new Error('use-reviews does not use timers.clearTimeout');
      },
      setInterval: () => {
        throw new Error('use-reviews does not use timers.setInterval');
      },
      clearInterval: () => {
        throw new Error('use-reviews does not use timers.clearInterval');
      },
      now: () => {
        throw new Error('use-reviews does not use timers.now');
      },
    },
  };
}

// Bun's `typeof fetch` also requires a static `preconnect` method that this
// stub has no use for; the cast documents that this is a deliberate
// call-should-never-happen sentinel, not a real fetch implementation.
const unusedFetch = (() =>
  Promise.reject(new Error('fetch should not be called in this test'))) as unknown as typeof fetch;

describe('createReviewsStore', () => {
  it('seeds reviews from the initial value', () => {
    const store = createReviewsStore([makeHumanWait()], createEnvironment(unusedFetch));
    expect(store.reviews).toHaveLength(1);
    expect(store.loading).toBe(false);
    expect(store.pendingId).toBeUndefined();
    expect(store.error).toBeUndefined();
  });

  it('replaces the review list on refresh', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify([makeHumanWait({ id: 'refreshed' })]))),
    );

    const store = createReviewsStore(
      [makeHumanWait({ id: 'stale' })],
      createEnvironment(fetchMock as unknown as typeof fetch),
    );
    await store.refresh();

    expect(store.reviews.map((review) => review.id)).toEqual(['refreshed']);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reviews');
  });

  it('records an error message when refresh fails', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ message: 'nope' }), { status: 500 })),
    );

    const store = createReviewsStore([], createEnvironment(fetchMock as unknown as typeof fetch));
    await store.refresh();

    expect(store.error).toBe('nope');
  });

  it('records the thrown error message when refresh rejects with a network failure', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('network unreachable')));

    const store = createReviewsStore([], createEnvironment(fetchMock as unknown as typeof fetch));
    await store.refresh();

    expect(store.error).toBe('network unreachable');
    expect(store.loading).toBe(false);
  });

  it('records a generic status message when refresh fails and the error body is not JSON', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('not json', { status: 503, statusText: 'Service Unavailable' })),
    );

    const store = createReviewsStore([], createEnvironment(fetchMock as unknown as typeof fetch));
    await store.refresh();

    expect(store.error).toBe('Request failed with status 503');
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

    const store = createReviewsStore(
      [review],
      createEnvironment(fetchMock as unknown as typeof fetch),
    );
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

    const store = createReviewsStore(
      [review],
      createEnvironment(fetchMock as unknown as typeof fetch),
    );
    await store.deny(review.id, { reason: 'not safe' });

    expect(store.reviews).toHaveLength(0);
  });

  it('keeps a review in the list and records an error when resolve fails', async () => {
    const review = makeHumanWait();
    const fetchMock = mock(() => Promise.resolve(new Response('conflict', { status: 409 })));

    const store = createReviewsStore(
      [review],
      createEnvironment(fetchMock as unknown as typeof fetch),
    );
    await store.approve(review.id);

    expect(store.reviews).toHaveLength(1);
    expect(store.error).toBe('Request failed with status 409');
  });
});
