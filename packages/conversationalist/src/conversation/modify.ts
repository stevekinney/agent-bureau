import { type ConversationEnvironment, resolveConversationEnvironment } from '../environment';
import { createInvalidInputError } from '../errors';
import type { ConversationHistory as Conversation, Message, ToolResult } from '../types';
import { hasOwnProperty, repositionMessage, toReadonly } from '../utilities';
import {
  createUpdatedMessage,
  type InternalMessageUpdate,
  type MessageUpdate,
} from './mutation-plugins';
import { ensureConversationSafe } from './validation';

const replaceKnownMessage = (
  conversation: Conversation,
  message: Message,
  updates: InternalMessageUpdate,
  environment?: Partial<ConversationEnvironment>,
): Conversation => {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const updatedMessage = createUpdatedMessage(message, updates, resolvedEnvironment);
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [message.id]: updatedMessage },
    updatedAt: resolvedEnvironment.now(),
  };

  return ensureConversationSafe(toReadonly(next));
};

/**
 * Returns a new history with editable fields replaced on the identified message.
 * Message identity, role, order, and creation time are preserved. An unknown
 * message identifier returns the original history unchanged.
 */
export function updateMessage(
  conversation: Conversation,
  messageId: string,
  updates: MessageUpdate,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  if (!hasOwnProperty(conversation.messages, messageId)) return conversation;
  const message = conversation.messages[messageId];
  return message ? replaceKnownMessage(conversation, message, updates, environment) : conversation;
}

/**
 * Returns a new history without the identified message and renumbers every
 * surviving message to keep positions contiguous. An unknown identifier
 * returns the original history unchanged.
 */
export function removeMessage(
  conversation: Conversation,
  messageId: string,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  if (!hasOwnProperty(conversation.messages, messageId)) return conversation;

  const ids = conversation.ids.filter((id) => id !== messageId);
  const messages: Record<string, Message> = { ...conversation.messages };
  delete messages[messageId];

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = repositionMessage(message, position);
  }

  const next: Conversation = {
    ...conversation,
    ids,
    messages,
    updatedAt: resolveConversationEnvironment(environment).now(),
  };

  return ensureConversationSafe(toReadonly(next));
}

/**
 * Returns a new history with the identified message hidden or visible.
 * An unknown message identifier returns the original history unchanged.
 */
export function setMessageHidden(
  conversation: Conversation,
  messageId: string,
  hidden: boolean,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return updateMessage(conversation, messageId, { hidden }, environment);
}

/**
 * Returns a new history with the result for `toolCallId` replaced in place.
 * The result message keeps its identity and order. An unknown tool-call
 * identifier returns the original history unchanged. Throws when the
 * replacement result identifies a different tool call.
 */
export function replaceToolResult(
  conversation: Conversation,
  toolCallId: string,
  toolResult: ToolResult,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const message = conversation.ids
    .map((id) => conversation.messages[id])
    .find(
      (candidate): candidate is Message & { toolResult: ToolResult } =>
        candidate?.role === 'tool-result' && candidate.toolResult?.callId === toolCallId,
    );

  if (!message) return conversation;
  if (toolResult.callId !== toolCallId) {
    throw createInvalidInputError(
      `toolResult.callId (${toolResult.callId}) does not match toolCallId (${toolCallId})`,
      { toolCallId, toolResultCallId: toolResult.callId },
    );
  }

  return replaceKnownMessage(conversation, message, { toolResult }, environment);
}
