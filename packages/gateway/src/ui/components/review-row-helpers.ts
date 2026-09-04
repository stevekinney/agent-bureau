/**
 * Pure helpers extracted from `review-row.svelte`'s `<script module>` block
 * (AB-316). TypeScript's ambient `*.svelte` module declaration only exposes
 * a default export, so a named `<script module>` export type-checks at
 * runtime but is invisible to a `.ts` test file importing it directly
 * (`TS2614: Module '"*.svelte"' has no exported member ...`) — matching
 * `chat-review-announcements.ts`'s existing precedent, these live in a
 * plain module instead.
 */

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

/**
 * Parses the optional response-payload textarea for a `human-wait` review's
 * approve action: JSON when it parses, the trimmed plain text otherwise,
 * `undefined` when blank.
 */
export function parseReviewPayload(payloadText: string): unknown {
  const trimmed = payloadText.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed; // not JSON — send as a plain string
  }
}
