/**
 * Pluggable compaction strategies for managing context window size.
 *
 * Each strategy operates on a `Conversation` in place using the conversation's
 * built-in mutation methods (`compact`, `truncateFromPosition`, etc.).
 */

import type { Conversation, Message } from 'conversationalist';

import { getPendingToolCallIds } from './pending-tool-calls';
import type { TokenBudget } from './token-budget';
import type { CompactionOptions, CompactionStrategy } from './types';

/**
 * Returns the set of message IDs that must be preserved because they belong
 * to pending tool call/result pairs.
 */
function getProtectedMessageIds(messages: ReadonlyArray<Message>): Set<string> {
  const pendingCallIds = getPendingToolCallIds(messages);
  const protectedIds = new Set<string>();

  for (const message of messages) {
    if (
      message.role === 'tool-call' &&
      message.toolCall &&
      pendingCallIds.has(message.toolCall.id)
    ) {
      protectedIds.add(message.id);
    }
    if (
      message.role === 'tool-result' &&
      message.toolResult &&
      pendingCallIds.has(message.toolResult.callId)
    ) {
      protectedIds.add(message.id);
    }
  }
  return protectedIds;
}

/**
 * Creates a sliding-window compaction strategy.
 *
 * Drops all messages outside the retain window, always preserving system
 * messages and pending tool call/result pairs. Uses `Conversation.compact()`
 * with a no-op summarizer that produces a short marker.
 */
export function createSlidingWindowStrategy(): CompactionStrategy {
  return async (
    conversation: Conversation,
    _budget: TokenBudget,
    options: CompactionOptions,
  ): Promise<void> => {
    const retainRecent = options.retainRecentMessages ?? 4;
    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');

    if (nonSystem.length <= retainRecent) {
      return;
    }

    // Use conversation.compact() which already handles system preservation,
    // tool pair preservation, and recent message retention.
    await conversation.compact(
      () => Promise.resolve('[context compacted — earlier messages removed]'),
      {
        preserveRecentCount: retainRecent,
        preserveSystemMessages: true,
        preserveToolPairs: true,
      },
    );
  };
}

/**
 * Creates a selective-pruning compaction strategy.
 *
 * Redacts old tool-result messages (replacing content with a placeholder)
 * while keeping tool-call breadcrumbs intact. Preserves recent messages,
 * system messages, and pending tool pairs.
 */
export function createSelectivePruningStrategy(): CompactionStrategy {
  return (
    conversation: Conversation,
    _budget: TokenBudget,
    options: CompactionOptions,
  ): Promise<void> => {
    const retainRecent = options.retainRecentMessages ?? 4;
    const maxAge = options.maxToolResultAge ?? 5;
    const messages = conversation.getMessages();
    const nonSystem = messages.filter((m) => m.role !== 'system');

    if (nonSystem.length === 0) return Promise.resolve();

    // Identify protected messages
    const protectedIds = getProtectedMessageIds(messages);

    // Count turns from the end to determine age
    const totalNonSystem = nonSystem.length;
    const recentStart = Math.max(0, totalNonSystem - retainRecent);

    // Prune old tool results by redacting them in place
    for (let i = 0; i < nonSystem.length; i++) {
      const message = nonSystem[i]!;
      if (protectedIds.has(message.id)) continue;
      if (i >= recentStart) continue;

      if (message.role === 'tool-result' && message.toolResult) {
        const turnsFromEnd = totalNonSystem - i;
        if (turnsFromEnd > maxAge) {
          conversation.redactMessageAtPosition(message.position, {
            placeholder: '[pruned tool result]',
            redactToolResults: true,
          });
        }
      }
    }

    return Promise.resolve();
  };
}

/**
 * Creates a hybrid compaction strategy.
 *
 * Combines summarization of old non-tool messages, pruning of old tool
 * results, and a sliding window for recency. When no `summarize` function
 * is provided, falls back to sliding-window behavior.
 *
 * Pending tool calls (those without a corresponding result) and their
 * associated messages are always preserved because the model may still
 * need to process their results.
 */
export function createHybridStrategy(): CompactionStrategy {
  return async (
    conversation: Conversation,
    budget: TokenBudget,
    options: CompactionOptions,
  ): Promise<void> => {
    const retainRecent = options.retainRecentMessages ?? 4;
    const summarize = options.summarize;

    if (!summarize) {
      // Fall back to sliding window
      const slidingWindow = createSlidingWindowStrategy();
      return slidingWindow(conversation, budget, options);
    }

    // Identify pending tool call IDs before compaction so we can
    // ensure they're included in the preserve count.
    const messages = conversation.getMessages();
    const protectedIds = getProtectedMessageIds(messages);
    const nonSystem = messages.filter((m) => m.role !== 'system');

    // Count how many non-system messages from the end we need to keep
    // to cover both retainRecent and all pending tool calls.
    let effectiveRetain = retainRecent;
    if (protectedIds.size > 0) {
      // Find the earliest protected message position in non-system list
      for (let i = 0; i < nonSystem.length; i++) {
        const msg = nonSystem[i]!;
        if (protectedIds.has(msg.id)) {
          const fromEnd = nonSystem.length - i;
          effectiveRetain = Math.max(effectiveRetain, fromEnd);
          break;
        }
      }
    }

    await conversation.compact(async (msgs, _opts) => summarize(msgs), {
      preserveRecentCount: effectiveRetain,
      preserveSystemMessages: true,
      preserveToolPairs: true,
    });
  };
}
