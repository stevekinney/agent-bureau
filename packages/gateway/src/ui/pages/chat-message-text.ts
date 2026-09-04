import type { MultiModalContent } from '@lostgradient/chat';

/**
 * Extracts plain text from a submitted chat message's content. Extracted
 * from `chat.svelte`'s instance script (AB-316) — as a `ChatSubmitEvent`
 * handler it is otherwise only reachable through a real DOM submit
 * interaction, which this package's SSR-only test setup cannot dispatch;
 * pulling the pure extraction logic out here (matching the existing
 * `chat-review-announcements.ts` precedent) makes it directly unit-testable.
 */
export function extractChatMessageText(content: string | MultiModalContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
