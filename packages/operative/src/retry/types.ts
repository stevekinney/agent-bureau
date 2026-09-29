import type { ConversationHistory } from 'conversationalist';

import type { GenerateContext } from '../types';

/**
 * Transforms the generate context before a retry attempt.
 *
 * Return a new context to replace the current one, or void to leave
 * it unchanged. The mutator receives the error that triggered the retry,
 * the current attempt number (1-indexed), and the conversation history the
 * failed attempt was sent with.
 */
export type RetryMutator = (
  context: GenerateContext,
  error: unknown,
  attempt: number,
  /**
   * The conversation history the failed attempt was sent with, captured
   * immediately before its `generate()` call. Compare it with
   * `context.conversation.current` to tell whether another writer, such as
   * a background compaction, changed the history while the request was in
   * flight. The retry loop always passes it; it is absent only when a
   * mutator is called directly.
   */
  sentHistory?: ConversationHistory,
) => Promise<GenerateContext | void> | GenerateContext | void;
