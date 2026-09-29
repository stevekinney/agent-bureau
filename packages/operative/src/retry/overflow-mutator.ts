import type { Conversation, ConversationHistory, Message, Summarizer } from 'conversationalist';

import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

/** Options for creating an overflow mutator. */
export interface OverflowMutatorOptions {
  /**
   * Summarizes older messages into a compact string.
   * Called with the messages that will be replaced by the summary.
   */
  summarize: (messages: ReadonlyArray<Message>) => Promise<string>;
  /**
   * Number of recent messages to retain verbatim after compaction.
   * Defaults to 4.
   */
  retainRecentMessages?: number | undefined;
  /**
   * Classifies an error as `'overflow'` or another category.
   * When omitted, a default classifier checks for common overflow
   * patterns in the error message.
   */
  classifyError?: ((error: unknown) => string) | undefined;
}

const OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'too many tokens',
  'max_tokens',
  'context window',
  'token limit',
];

function defaultClassifyError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  for (const pattern of OVERFLOW_PATTERNS) {
    if (message.includes(pattern)) return 'overflow';
  }
  return 'unknown';
}

/** The durable messages a recovery saw, as one comparable value. */
function durableBoundary(conversation: Conversation): string {
  return JSON.stringify(conversation.ids);
}

/**
 * Whether the conversation was rewritten, not merely extended, since it held
 * `sentIds`. A committed compaction always rewrites it: the summary and every
 * retained message carry new ids.
 */
function rewrittenSince(sentIds: ReadonlyArray<string>, conversation: Conversation): boolean {
  const ids = conversation.ids;
  return sentIds.some((id, index) => ids[index] !== id);
}

/**
 * Creates a retry mutator that recovers from a provider context overflow
 * by compacting the run's conversation once.
 *
 * Retry mutators run inside the step's provider-retry loop, before the step
 * appends assistant output or executes a tool, so recovery always happens
 * before this step's durable effects. Within that window it is bounded:
 *
 * - It compacts through `Conversation.compact()`, the revisioned
 *   compare-and-swap, so the summary replaces the history the next attempt
 *   and every later step read. It never builds a throwaway copy.
 * - It does not wait for other compactions, such as a background candidate
 *   from `contextManagement.background`. It compares the history the failed
 *   request was sent with (the retry loop's `sentHistory`) against the
 *   current one. When another writer rewrote it in between, as a committed
 *   compaction always does — whether while the provider was still answering
 *   or while this mutator's own summary was being written — the history that
 *   overflowed is already gone. Recovery then retries once against the
 *   rewritten history instead of compacting it again; the compare-and-swap
 *   has already discarded this mutator's summary if one was running.
 * - It compacts, or adopts another writer's compaction, at most once per
 *   durable boundary. When the retry overflows again before any new message
 *   has landed, it rethrows that provider error, ending the retry loop
 *   instead of compacting or retrying again.
 * - It never compacts over an open stream: partial streamed output is not
 *   durable, so it rethrows rather than summarize or replay it.
 * - When there is nothing to compact, or a concurrent write that only
 *   extended the history made the compaction stale, it rethrows too: the
 *   history the request overflowed on is still there, so retrying would
 *   only overflow again.
 */
export function createOverflowMutator(options: OverflowMutatorOptions): RetryMutator {
  const { summarize, retainRecentMessages = 4, classifyError = defaultClassifyError } = options;
  const summarizer: Summarizer = async (messages) =>
    `Previous conversation summary: ${await summarize(messages)}`;
  // Per conversation: the durable boundary this mutator's last recovery left.
  const compactedAt = new WeakMap<Conversation, string>();

  return async (
    context: GenerateContext,
    error: unknown,
    _attempt: number,
    sentHistory?: ConversationHistory,
  ): Promise<GenerateContext | undefined> => {
    if (classifyError(error) !== 'overflow') return undefined;

    const { conversation } = context;
    if (conversation.getStreamingMessage() !== undefined) throw error;
    if (compactedAt.get(conversation) === durableBoundary(conversation)) throw error;

    // Called outside the retry loop, the history now is the one that overflowed.
    const sentIds = sentHistory?.ids ?? conversation.ids;
    if (!rewrittenSince(sentIds, conversation)) {
      const result = await conversation.compact(summarizer, {
        preserveRecentCount: retainRecentMessages,
        signal: context.signal,
      });
      if (result.outcome === 'no-op') throw error;
      if (result.outcome === 'discarded' && !rewrittenSince(sentIds, conversation)) throw error;
    }
    compactedAt.set(conversation, durableBoundary(conversation));

    // A new context object marks the retry as mutated, so it seals a
    // successor effective-context epoch for the compacted request.
    return { ...context };
  };
}
