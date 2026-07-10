<script lang="ts" module>
  /** Formats an age in milliseconds as a compact human string (e.g. `"2m"`, `"3h"`, `"just now"`). */
  export function formatAge(milliseconds: number): string {
    if (milliseconds < 1000) return 'just now';
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
</script>

<script lang="ts">
  import { Badge } from '@lostgradient/cinder/badge';
  import { Button } from '@lostgradient/cinder/button';
  import { Card } from '@lostgradient/cinder/card';
  import { Link } from '@lostgradient/cinder/link';
  import { PayloadInspector } from '@lostgradient/cinder/payload-inspector';
  import { Textarea } from '@lostgradient/cinder/textarea';

  import type { PendingReview } from '../../types';

  let {
    review,
    pending,
    onapprove,
    ondeny,
  }: {
    review: PendingReview;
    /** True while an approve/deny request for THIS review is in flight. */
    pending: boolean;
    onapprove: (id: string, payload?: unknown) => void;
    ondeny: (id: string, reason?: string) => void;
  } = $props();

  // For a human-wait review the approver can optionally attach a JSON payload
  // (delivered as the signal's payload) or a plain-text reason for denial.
  let payloadText = $state('');
  let reasonText = $state('');

  function parsePayload(): unknown {
    const trimmed = payloadText.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed; // not JSON — send as a plain string
    }
  }

  function handleApprove(): void {
    onapprove(review.id, review.kind === 'human-wait' ? parsePayload() : undefined);
  }

  function handleDeny(): void {
    ondeny(review.id, reasonText.trim() || undefined);
  }
</script>

<Card>
  {#snippet header()}
    <div class="review-row-header">
      <Badge variant={review.kind === 'tool-approval' ? 'warning' : 'info'} size="sm">
        {review.kind === 'tool-approval' ? 'Tool approval' : 'Human input'}
      </Badge>
      <h3 class="review-row-title">
        {review.kind === 'tool-approval' ? review.approval.toolName : review.signalName}
      </h3>
      <span class="review-row-age">{formatAge(review.ageMilliseconds)} ago</span>
    </div>
    <div class="review-row-meta">
      <Link href={`/runs/${review.runId}`}>{review.runId}</Link>
      {#if review.agentName}
        <span class="review-row-agent">· {review.agentName}</span>
      {/if}
    </div>
  {/snippet}

  {#if review.kind === 'tool-approval'}
    {#if review.approval.reason}
      <p class="review-row-reason">{review.approval.reason}</p>
    {/if}
    <PayloadInspector value={review.approval.arguments} />
  {:else}
    {#if review.prompt}
      <p class="review-row-reason">{review.prompt}</p>
    {/if}
    <Textarea
      id={`review-payload-${review.id}`}
      label="Response payload (optional)"
      description="Plain text, or JSON — delivered as the signal's payload."
      rows={2}
      bind:value={payloadText}
      disabled={pending}
    />
  {/if}

  {#snippet footer()}
    <div class="review-row-actions">
      <Textarea
        id={`review-reason-${review.id}`}
        label="Reason (optional, shown on deny)"
        rows={1}
        bind:value={reasonText}
        disabled={pending}
      />
      <div class="review-row-buttons">
        <Button
          variant="danger"
          size="sm"
          label="Deny"
          loading={pending}
          disabled={pending}
          onclick={handleDeny}
        />
        <Button
          variant="primary"
          size="sm"
          label="Approve"
          loading={pending}
          disabled={pending}
          onclick={handleApprove}
        />
      </div>
    </div>
  {/snippet}
</Card>

<style>
  .review-row-header {
    display: flex;
    align-items: baseline;
    gap: var(--cinder-space-3, 0.5rem);
    flex-wrap: wrap;
  }

  .review-row-title {
    margin: 0;
    font-size: 1rem;
  }

  .review-row-age {
    margin-left: auto;
    color: var(--cinder-text-subtle, currentColor);
    font-size: var(--cinder-text-xs, 0.8125rem);
  }

  .review-row-meta {
    margin-top: 0.25rem;
    font-size: var(--cinder-text-xs, 0.8125rem);
    color: var(--cinder-text-subtle, currentColor);
  }

  .review-row-reason {
    margin: 0 0 0.5rem;
  }

  .review-row-actions {
    display: flex;
    align-items: flex-end;
    gap: var(--cinder-space-4, 1rem);
    flex-wrap: wrap;
  }

  .review-row-actions :global(.cinder-textarea) {
    flex: 1;
    min-width: 12rem;
  }

  .review-row-buttons {
    display: flex;
    gap: var(--cinder-space-3, 0.5rem);
  }
</style>
