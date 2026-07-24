<script lang="ts">
  import { Callout } from '@lostgradient/cinder/callout';
  import { PageHeader } from '@lostgradient/cinder/page-header';
  import { Chat } from '@lostgradient/chat';
  import type { ChatSubmitEvent, MultiModalContent } from '@lostgradient/chat';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';

  import ReviewRow from '../components/review-row.svelte';
  import type { ChatStore } from '../hooks/use-chat.svelte';
  import type { ReviewsStore } from '../hooks/use-reviews.svelte';
  import { announcePendingReviews } from './chat-review-announcements';

  /**
   * Chat page. Adopts cinder's full {@link Chat} component for the transcript,
   * composer, streaming indicator, and jump-to-latest behavior. The
   * conversation, streaming, and error state are owned by the chat store
   * (use-chat.svelte.ts) and passed in by {@link app.svelte}.
   *
   * Attachments are disabled: the gateway run API accepts a plain text message,
   * so the composer only emits text.
   *
   * AB-23 (elicitation end-to-end): an agent invoking `requestHumanInput`
   * (durable park) or hitting armorer's `needs_approval` tool policy (live or
   * durable) produces a {@link PendingReview} scoped to the active run. This
   * page renders that review inline, right in the chat surface, using the
   * same {@link ReviewRow} form the AB-20 review queue page uses — so the
   * response is submitted through the identical `resolveReview` API and
   * resumes the run the same way, whether it was parked in-memory or
   * durably. `reviews` is shared with the reviews page's store rather than
   * duplicated so there is exactly one fetch/approve/deny implementation.
   */
  let { chat, reviews }: { chat: ChatStore; reviews: ReviewsStore } = $props();

  let chatComponent = $state<ReturnType<typeof Chat> | undefined>();
  const announcedReviewKeys = new Set<string>();

  /** Pending reviews belonging to the chat's active run, oldest first. */
  let pendingReviews = $derived(
    chat.runId === undefined ? [] : reviews.reviews.filter((review) => review.runId === chat.runId),
  );

  $effect(() => {
    if (!chatComponent || chat.runId === undefined) return;
    announcePendingReviews(chat.runId, pendingReviews, announcedReviewKeys, chatComponent.announce);
  });

  /** Extracts plain text from a submitted message's content. */
  function extractText(content: string | MultiModalContent[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  function handleSubmit(event: ChatSubmitEvent): void {
    const text = extractText(event.message.content).trim();
    if (!text) return;
    void chat.send(text);
  }

  // `sending` is true only for the brief POST that creates the run; the actual
  // assistant tokens stream in afterward and accumulate into
  // `streamingAssistantContent` (cleared on completion). The composer must stay
  // disabled and the indicator lit across BOTH phases.
  let isStreaming = $derived(chat.sending || Boolean(chat.streamingAssistantContent));
</script>

<main class="page-chat">
  <PageHeader title="Chat" />

  {#if chat.error}
    <Callout variant="danger" title="Chat error">{chat.error}</Callout>
  {/if}

  {#if reviews.error}
    <Callout variant="danger" title="Review error">{reviews.error}</Callout>
  {/if}

  {#if pendingReviews.length > 0}
    <section class="chat-pending-input">
      <SectionHeading level={2} title="Needs your input" />
      <div class="chat-pending-input-list">
        {#each pendingReviews as review (review.id)}
          <ReviewRow
            {review}
            pending={reviews.pendingId === review.id}
            onapprove={(id, payload) => void reviews.approve(id, { payload })}
            ondeny={(id, reason) => void reviews.deny(id, { reason })}
          />
        {/each}
      </div>
    </section>
  {/if}

  <Chat
    bind:this={chatComponent}
    id="gateway-chat"
    class="gateway-chat-surface"
    conversation={chat.conversation}
    streaming={isStreaming}
    streamingStatus={isStreaming ? 'Generating response…' : undefined}
    capabilities={{ attachments: false }}
    onsubmit={handleSubmit}
    emptyPrompts={['Ask the agent to do something…']}
  />

  {#if chat.toolActivity.length > 0}
    <section class="chat-tool-activity">
      <SectionHeading level={2} title="Tool Activity" />
      <ul>
        {#each chat.toolActivity as entry, index (`${entry}-${index}`)}
          <li>{entry}</li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  /*
   * Cinder's <Chat> root is `height: 100%`, so it needs a
   * definite-height parent or it collapses to its content. Make the page a
   * full-height flex column and let the chat fill the remaining space below the
   * heading.
   */
  .page-chat {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: 100%;
  }

  .page-chat > :global(.gateway-chat-surface) {
    flex: 1;
    min-height: 0;
  }

  .chat-tool-activity {
    margin-bottom: 1rem;
  }

  .chat-pending-input {
    flex-shrink: 0;
  }

  .chat-pending-input-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4, 1rem);
  }
</style>
