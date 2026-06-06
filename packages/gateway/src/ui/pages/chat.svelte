<script lang="ts">
  import { Callout } from '@lostgradient/cinder/callout';
  import { Chat } from '@lostgradient/cinder/chat';
  import type { ChatSubmitEvent, MultiModalContent } from '@lostgradient/cinder/chat';
  import { SectionHeading } from '@lostgradient/cinder/section-heading';

  import type { ChatStore } from '../hooks/use-chat.svelte';

  /**
   * Chat page. Adopts cinder's full {@link Chat} component for the transcript,
   * composer, streaming indicator, and jump-to-latest behavior. The
   * conversation, streaming, and error state are owned by the chat store
   * (use-chat.svelte.ts) and passed in by {@link app.svelte}.
   *
   * Attachments are disabled: the gateway run API accepts a plain text message,
   * so the composer only emits text.
   */
  let { chat }: { chat: ChatStore } = $props();

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
  <SectionHeading level={2} title="Chat" />

  {#if chat.error}
    <Callout variant="danger" title="Chat error">{chat.error}</Callout>
  {/if}

  <Chat
    id="gateway-chat"
    conversation={chat.conversation}
    {isStreaming}
    streamingStatus={isStreaming ? 'Generating response…' : undefined}
    allowAttachments={false}
    onsubmit={handleSubmit}
    emptyPrompts={['Ask the agent to do something…']}
  />

  {#if chat.toolActivity.length > 0}
    <section class="chat-tool-activity">
      <SectionHeading level={3} title="Tool Activity" />
      <ul>
        {#each chat.toolActivity as entry, index (`${entry}-${index}`)}
          <li>{entry}</li>
        {/each}
      </ul>
    </section>
  {/if}
</main>
