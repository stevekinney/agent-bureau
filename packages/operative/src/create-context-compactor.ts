import type {
  CompactionPreservePolicy,
  Conversation,
  Message,
  Summarizer,
} from 'conversationalist';

import type { StepContext } from './types';

/**
 * Options for `createContextCompactor`.
 */
export interface CreateContextCompactorOptions {
  /**
   * Summarizes a list of messages into a single string. The consumer provides
   * this function — operative does not import an LLM SDK.
   */
  summarize: (messages: ReadonlyArray<Message>) => Promise<string>;
  /**
   * Number of recent messages to keep verbatim after the summary. This value
   * is forwarded to `Conversation.compact({ preserveRecentCount })` and is
   * therefore a message-count setting, not a user/assistant turn-pair count.
   * Default: `4`.
   */
  retainRecentMessages?: number;
  /**
   * Text prepended to the summary when injected as a system message.
   * Default: `'Previous conversation summary:'`.
   */
  summaryPrefix?: string;
  /**
   * Structured preserve policy forwarded to `Conversation.compact()`:
   * pinned messages, decision/error annotations. See
   * `CompactionPreservePolicy` in conversationalist. All flags default to
   * `true` when omitted.
   */
  preservePolicy?: CompactionPreservePolicy;
}

/**
 * Creates a reusable `onCompact` implementation for `ContextManagementOptions`.
 *
 * Delegates to the conversationalist `Conversation.compact()` method which
 * handles chunking, tool-pair preservation, tool-result stripping, and
 * event emission.
 *
 * @example
 * ```ts
 * const compactor = createContextCompactor({
 *   summarize: async (messages) => callLLM(messages),
 *   retainRecentMessages: 6,
 * });
 *
 * await run({
 *   generate,
 *   toolbox,
 *   conversation,
 *   contextManagement: { maxTokens: 4000, onCompact: compactor },
 * });
 * ```
 */
export function createContextCompactor(
  options: CreateContextCompactorOptions,
): (conversation: Conversation, context: StepContext) => Promise<void> {
  const {
    summarize,
    retainRecentMessages = 4,
    summaryPrefix = 'Previous conversation summary:',
    preservePolicy,
  } = options;

  // Adapt the consumer's summarize function to conversationalist's Summarizer
  // signature, prepending the summary prefix.
  const summarizer: Summarizer = async (messages, _summarizerOptions) => {
    const summary = await summarize(messages);
    return `${summaryPrefix}\n${summary}`;
  };

  return async (conversation: Conversation, _context: StepContext): Promise<void> => {
    await conversation.compact(summarizer, {
      preserveRecentCount: retainRecentMessages,
      ...(preservePolicy ? { preservePolicy } : {}),
    });
  };
}
