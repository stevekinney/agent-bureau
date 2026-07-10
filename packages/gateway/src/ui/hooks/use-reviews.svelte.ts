import type { PendingReview, ResolveReviewResult } from '../../types';

/**
 * Reactive store for the review queue page (AB-20). Unlike the runs store,
 * reviews are not fed by the websocket/SSE frame system — an approve/deny
 * decision is a direct user action, not a background event — so this store
 * is purely fetch-driven: `refresh()` on mount, then an optimistic local
 * removal after a successful `approve`/`deny` (confirmed by the next
 * `refresh()`, which callers should trigger on a cadence of their choosing).
 */
export interface ReviewsStore {
  /** The current pending reviews. Reactive — read directly, never destructure. */
  readonly reviews: PendingReview[];
  /** True while the initial/manual list fetch is in flight. */
  readonly loading: boolean;
  /** True while an approve/deny request for `pendingId` is in flight. */
  readonly pendingId: string | undefined;
  /** The latest fetch/approve/deny error, if any. */
  readonly error: string | undefined;
  /** Refetches the full review list from the API. */
  refresh: () => Promise<void>;
  /** Approves a review — resumes the parked run. */
  approve: (id: string, options?: { arguments?: unknown; payload?: unknown }) => Promise<void>;
  /** Denies a review — records the decision without resuming anything. */
  deny: (id: string, options?: { reason?: string }) => Promise<void>;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string } | undefined;
    if (body?.message) return body.message;
  } catch {
    // fall through to the generic message below
  }
  return `Request failed with status ${response.status}`;
}

/**
 * Creates a {@link ReviewsStore} seeded with the server-provided initial
 * reviews.
 */
export function createReviewsStore(initialReviews: PendingReview[]): ReviewsStore {
  let reviews = $state<PendingReview[]>(initialReviews);
  let loading = $state(false);
  let pendingId = $state<string | undefined>(undefined);
  let error = $state<string | undefined>(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    try {
      const response = await fetch('/api/v1/reviews');
      if (!response.ok) {
        error = await parseErrorMessage(response);
        return;
      }
      reviews = (await response.json()) as PendingReview[];
      error = undefined;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  async function resolve(
    id: string,
    decision: 'approve' | 'deny',
    body: Record<string, unknown>,
  ): Promise<ResolveReviewResult | undefined> {
    pendingId = id;
    try {
      const response = await fetch(`/api/v1/reviews/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        error = await parseErrorMessage(response);
        return undefined;
      }
      const outcome = (await response.json()) as ResolveReviewResult;
      // Optimistically drop the resolved review — the server has already
      // marked it resolved, so a stale copy in the list would let a second
      // click retry a decision that already landed.
      reviews = reviews.filter((review) => review.id !== id);
      error = undefined;
      return outcome;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    } finally {
      pendingId = undefined;
    }
  }

  async function approve(
    id: string,
    options?: { arguments?: unknown; payload?: unknown },
  ): Promise<void> {
    await resolve(id, 'approve', {
      ...(options && Object.prototype.hasOwnProperty.call(options, 'arguments')
        ? { arguments: options.arguments }
        : {}),
      ...(options?.payload !== undefined ? { payload: options.payload } : {}),
    });
  }

  async function deny(id: string, options?: { reason?: string }): Promise<void> {
    await resolve(id, 'deny', options?.reason !== undefined ? { reason: options.reason } : {});
  }

  return {
    get reviews() {
      return reviews;
    },
    get loading() {
      return loading;
    },
    get pendingId() {
      return pendingId;
    },
    get error() {
      return error;
    },
    refresh,
    approve,
    deny,
  };
}
