import type { Conversation, Message } from '../types';
import { messageHasImages } from '../utilities';
import { getOrderedMessages } from '../utilities/message-store';

/**
 * Returns all messages from a conversation in order.
 * By default excludes hidden messages unless includeHidden is true.
 */
export function getMessages(
  conversation: Conversation,
  options?: { includeHidden?: boolean },
): Message[] {
  const includeHidden = options?.includeHidden ?? false;
  const ordered = getOrderedMessages(conversation);
  return includeHidden ? ordered : ordered.filter((m) => !m.hidden);
}

/**
 * Returns the message at the specified position index.
 * Returns undefined if no message exists at that position.
 */
export function getMessageAtPosition(
  conversation: Conversation,
  position: number,
): Message | undefined {
  const id = conversation.ids[position];
  return id ? conversation.messages[id] : undefined;
}

/**
 * Returns all message IDs for the conversation in order.
 */
export function getMessageIds(conversation: Conversation): string[] {
  return [...conversation.ids];
}

/**
 * Finds a message by its unique identifier.
 * Returns undefined if no message with that ID exists.
 */
export function getMessageById(
  conversation: Conversation,
  id: string,
): Message | undefined {
  return conversation.messages[id];
}

/**
 * Filters messages using a custom predicate function.
 * Returns all messages for which the predicate returns true.
 */
export function searchConversationMessages(
  conversation: Conversation,
  predicate: (m: Message) => boolean,
): Message[] {
  return getOrderedMessages(conversation).filter(predicate);
}

/**
 * Computes statistics about a conversation's messages.
 * Returns totals, counts by role, hidden message count, and image count.
 */
export function getStatistics(conversation: Conversation): {
  total: number;
  byRole: Record<string, number>;
  hidden: number;
  withImages: number;
} {
  const ordered = getOrderedMessages(conversation);
  const stats = ordered.reduce(
    (acc, message) => {
      const byRole = {
        ...acc.byRole,
        [message.role]: (acc.byRole[message.role] ?? 0) + 1,
      };

      return {
        byRole,
        hidden: acc.hidden + (message.hidden ? 1 : 0),
        withImages: acc.withImages + (messageHasImages(message) ? 1 : 0),
      };
    },
    { byRole: {} as Record<string, number>, hidden: 0, withImages: 0 },
  );
  return { total: ordered.length, ...stats };
}
