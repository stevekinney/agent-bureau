<script lang="ts">
  import { Callout } from '@lostgradient/cinder/callout';
  import { EmptyState } from '@lostgradient/cinder/empty-state';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';

  import ReviewRow from '../components/review-row.svelte';
  import type { ReviewsStore } from '../hooks/use-reviews.svelte';

  /**
   * Review queue page (AB-20). Lists every parked run awaiting human review —
   * armorer's `needs_approval` tool-approval flow AND durable
   * `requestHumanInput` waits — and lets the operator approve/deny each one.
   * State is owned by the reviews store (use-reviews.svelte.ts); this page
   * holds no state of its own.
   */
  let { reviews }: { reviews: ReviewsStore } = $props();
</script>

<main class="page-reviews">
  <SectionHeading level={2} title="Review Queue" />

  {#if reviews.error}
    <Callout variant="danger" title="Review queue error">{reviews.error}</Callout>
  {/if}

  {#if reviews.reviews.length === 0}
    <EmptyState
      title="Nothing pending review."
      description="Tool calls awaiting approval and runs parked on human input appear here."
    />
  {:else}
    <div class="review-list">
      {#each reviews.reviews as review (review.id)}
        <ReviewRow
          {review}
          pending={reviews.pendingId === review.id}
          onapprove={(id, payload) => void reviews.approve(id, { payload })}
          ondeny={(id, reason) => void reviews.deny(id, { reason })}
        />
      {/each}
    </div>
  {/if}
</main>

<style>
  .review-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4, 1rem);
  }
</style>
