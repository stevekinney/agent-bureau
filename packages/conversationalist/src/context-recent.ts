import {
  buildMessageBlocks,
  cloneMessageWithPosition,
  collectBlocksForMessages,
  collectMessagesFromBlocks,
  ensureTruncationSafe,
} from './context-blocks';
import { assertConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { resolveConversationEnvironment } from './environment';
import { copyContent } from './multi-modal';
import { isStreamingMessage } from './streaming';
import type { ConversationHistory as Conversation, Message } from './types';
import { toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

/**
 * Returns the last N messages from the conversation.
 * By default excludes system messages and hidden messages.
 * Tool interactions are preserved as atomic blocks by default.
 */
export function getRecentMessages(
  conversation: Conversation,
  count: number,
  options?: {
    includeHidden?: boolean;
    includeSystem?: boolean;
    preserveToolPairs?: boolean;
  },
): ReadonlyArray<Message> {
  const includeHidden = options?.includeHidden ?? false;
  const includeSystem = options?.includeSystem ?? false;
  const preserveToolPairs = options?.preserveToolPairs ?? true;

  const filtered = getOrderedMessages(conversation).filter((m) => {
    if (!includeHidden && m.hidden) return false;
    if (!includeSystem && m.role === 'system') return false;
    return true;
  });

  if (!preserveToolPairs) {
    return filtered.slice(-count);
  }

  const { messageToBlock } = buildMessageBlocks(filtered, () => 0, preserveToolPairs);
  const tail = filtered.slice(-count);
  const blocks = collectBlocksForMessages(tail, messageToBlock);
  return collectMessagesFromBlocks(blocks);
}

/**
 * Truncates conversation to keep only messages from the specified position onwards.
 * Optionally preserves system messages regardless of position.
 * Tool interactions are preserved as atomic blocks by default.
 */
export function truncateFromPosition(
  conversation: Conversation,
  position: number,
  options?: {
    preserveSystemMessages?: boolean;
    preserveToolPairs?: boolean;
  },
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  assertConversationSafe(conversation);
  const preserveSystem = options?.preserveSystemMessages ?? true;
  const preserveToolPairs = options?.preserveToolPairs ?? true;
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  const ordered = getOrderedMessages(conversation);
  const { messageToBlock } = buildMessageBlocks(ordered, () => 0, preserveToolPairs);
  const systemMessages = preserveSystem
    ? ordered.filter((m) => m.role === 'system' && m.position < position)
    : [];
  const streamingMessages = ordered.filter((m) => isStreamingMessage(m) && m.position < position);
  const keptMessages = ordered.filter((m) => m.position >= position);
  const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
  const streamingBlocks = collectBlocksForMessages(streamingMessages, messageToBlock);
  const keptBlocks = collectBlocksForMessages(keptMessages, messageToBlock);
  const allMessages = collectMessagesFromBlocks([
    ...systemBlocks,
    ...streamingBlocks,
    ...keptBlocks,
  ]);

  // Renumber positions
  const renumbered = allMessages.map((message, index) =>
    cloneMessageWithPosition(message, index, copyContent(message.content)),
  );

  const next = toReadonly({
    ...conversation,
    ids: renumbered.map((message) => message.id),
    messages: toIdRecord(renumbered),
    updatedAt: now,
  });
  return ensureTruncationSafe(next, preserveToolPairs, 'truncateFromPosition');
}
