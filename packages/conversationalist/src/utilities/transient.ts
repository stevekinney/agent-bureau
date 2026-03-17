import { ensureConversationSafe } from '../conversation/validation';
import type { AssistantMessage, Conversation, JSONValue, Message } from '../types';
import { isAssistantMessage } from './message';
import { getOrderedMessages, toIdRecord } from './message-store';
import { toReadonly } from './type-helpers';

/**
 * Checks if a metadata key is transient (starts with '_').
 * Transient metadata is intended for temporary UI state and should not be persisted.
 *
 * @param key - The metadata key to check
 * @returns true if the key starts with '_'
 *
 * @example
 * ```ts
 * isTransientKey('_tempId');     // true
 * isTransientKey('__internal');  // true
 * isTransientKey('source');      // false
 * ```
 */
export function isTransientKey(key: string): boolean {
  return key.startsWith('_');
}

/**
 * Strips transient metadata (keys starting with '_') from a metadata object.
 *
 * @param metadata - The metadata object to filter
 * @returns A new object with transient keys removed
 *
 * @example
 * ```ts
 * stripTransientFromRecord({ _temp: 1, source: 'web' });
 * // Returns: { source: 'web' }
 * ```
 */
export function stripTransientFromRecord(
  metadata: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const result: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!isTransientKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Strips all transient metadata from a conversation.
 * Transient metadata is identified by keys starting with '_'.
 * This is useful for persisting conversations without temporary UI state.
 *
 * @param conversation - The conversation to process
 * @returns A new conversation with transient metadata removed from both
 *          the conversation and all messages
 *
 * @example
 * ```ts
 * const cleaned = stripTransientMetadata(conversation);
 * // conversation.metadata._tempState is removed
 * // message.metadata._deliveryStatus is removed
 * ```
 */
export function stripTransientMetadata(conversation: Conversation): Conversation {
  const strippedMessages = getOrderedMessages(conversation).map((message): Message => {
    const baseMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      position: message.position,
      createdAt: message.createdAt,
      metadata: toReadonly(stripTransientFromRecord({ ...message.metadata })),
      hidden: message.hidden,
      toolCall: message.toolCall,
      toolResult: message.toolResult,
      tokenUsage: message.tokenUsage,
    };

    if (isAssistantMessage(message)) {
      const assistantMessage: AssistantMessage = {
        ...baseMessage,
        role: 'assistant',
        goalCompleted: message.goalCompleted,
      };
      return toReadonly(assistantMessage);
    }

    return toReadonly(baseMessage);
  });

  return ensureConversationSafe(
    toReadonly({
      schemaVersion: conversation.schemaVersion,
      id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      metadata: toReadonly(stripTransientFromRecord({ ...conversation.metadata })),
      ids: strippedMessages.map((message) => message.id),
      messages: toIdRecord(strippedMessages),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    }),
  );
}
