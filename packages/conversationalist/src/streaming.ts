import type { MultiModalContent } from '@lasercat/homogenaize';

import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from './environment';
import type {
  AssistantMessage,
  Conversation,
  JSONValue,
  Message,
  TokenUsage,
} from './types';
import { createMessage, isAssistantMessage, toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

const STREAMING_KEY = '__streaming';

const cloneMessage = (
  original: Message,
  overrides: {
    content?: string | MultiModalContent[];
    metadata?: Record<string, JSONValue>;
    position?: number;
    tokenUsage?: TokenUsage;
  } = {},
): Message => {
  const baseMessage = {
    id: original.id,
    role: original.role,
    content:
      overrides.content ??
      (typeof original.content === 'string'
        ? original.content
        : [...(original.content as MultiModalContent[])]),
    position: overrides.position ?? original.position,
    createdAt: original.createdAt,
    metadata: overrides.metadata ?? { ...original.metadata },
    hidden: original.hidden,
    toolCall: original.toolCall ? { ...original.toolCall } : undefined,
    toolResult: original.toolResult ? { ...original.toolResult } : undefined,
    tokenUsage: overrides.tokenUsage,
  };

  if (isAssistantMessage(original)) {
    const assistantMessage: AssistantMessage = {
      ...baseMessage,
      role: 'assistant',
      goalCompleted: original.goalCompleted,
    };
    return createMessage(assistantMessage);
  }

  return createMessage(baseMessage);
};

/**
 * Checks if a message is currently streaming (has the streaming metadata flag).
 */
export function isStreamingMessage(message: Message): boolean {
  return message.metadata[STREAMING_KEY] === true;
}

/**
 * Gets the currently streaming message from a conversation, if any.
 */
export function getStreamingMessage(conversation: Conversation): Message | undefined {
  return getOrderedMessages(conversation).find(isStreamingMessage);
}

/**
 * Creates a pending/streaming message placeholder and appends it to the conversation.
 * Returns both the updated conversation and the ID of the new streaming message.
 */
export function appendStreamingMessage(
  conversation: Conversation,
  role: 'assistant' | 'user',
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): { conversation: Conversation; messageId: string } {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(metadata) ? metadata : environment,
  );
  const resolvedMetadata = isConversationEnvironmentParameter(metadata)
    ? undefined
    : metadata;
  const now = resolvedEnvironment.now();
  const messageId = resolvedEnvironment.randomId();

  const newMessage = createMessage({
    id: messageId,
    role,
    content: '',
    position: conversation.ids.length,
    createdAt: now,
    metadata: { ...(resolvedMetadata ?? {}), [STREAMING_KEY]: true },
    hidden: false,
    toolCall: undefined,
    toolResult: undefined,
    tokenUsage: undefined,
  });

  const updatedConversation = toReadonly({
    ...conversation,
    ids: [...conversation.ids, messageId],
    messages: { ...conversation.messages, [messageId]: newMessage },
    updatedAt: now,
  });

  return { conversation: ensureConversationSafe(updatedConversation), messageId };
}

/**
 * Updates the content of a streaming message.
 * This replaces the existing content (use for accumulating streamed tokens).
 */
export function updateStreamingMessage(
  conversation: Conversation,
  messageId: string,
  content: string | MultiModalContent[],
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  const original = conversation.messages[messageId];
  if (!original) {
    return ensureConversationSafe(conversation);
  }

  const overrides: {
    content?: string | MultiModalContent[];
    tokenUsage?: TokenUsage;
  } = {
    content: typeof content === 'string' ? content : [...content],
  };
  if (original.tokenUsage) {
    overrides.tokenUsage = { ...original.tokenUsage };
  }

  const updated = cloneMessage(original, overrides);

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: [...conversation.ids],
      messages: { ...conversation.messages, [updated.id]: updated },
      updatedAt: now,
    }),
  );
}

/**
 * Marks a streaming message as complete, removing the streaming flag.
 * Optionally adds token usage and additional metadata.
 */
export function finalizeStreamingMessage(
  conversation: Conversation,
  messageId: string,
  options?: {
    tokenUsage?: TokenUsage;
    metadata?: Record<string, JSONValue>;
  },
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;
  const now = resolvedEnvironment.now();

  const original = conversation.messages[messageId];
  if (!original) {
    return ensureConversationSafe(conversation);
  }

  // Remove the streaming flag and merge in any new metadata
  const { [STREAMING_KEY]: _, ...restMetadata } = original.metadata as Record<
    string,
    JSONValue
  >;
  const finalMetadata: Record<string, JSONValue> = {
    ...restMetadata,
    ...(resolvedOptions?.metadata ?? {}),
  };

  const finalizeOverrides: {
    metadata?: Record<string, JSONValue>;
    tokenUsage?: TokenUsage;
  } = {
    metadata: finalMetadata,
  };
  if (resolvedOptions?.tokenUsage) {
    finalizeOverrides.tokenUsage = { ...resolvedOptions.tokenUsage };
  }

  const updated = cloneMessage(original, finalizeOverrides);

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: [...conversation.ids],
      messages: { ...conversation.messages, [updated.id]: updated },
      updatedAt: now,
    }),
  );
}

/**
 * Cancels a streaming message by removing it from the conversation.
 */
export function cancelStreamingMessage(
  conversation: Conversation,
  messageId: string,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  if (!conversation.messages[messageId]) {
    return ensureConversationSafe(conversation);
  }

  const messages = getOrderedMessages(conversation)
    .filter((m) => m.id !== messageId)
    .map((message, index) =>
      message.position === index
        ? message
        : (() => {
            const overrides: { position: number; tokenUsage?: TokenUsage } = {
              position: index,
            };
            if (message.tokenUsage) {
              overrides.tokenUsage = { ...message.tokenUsage };
            }
            return cloneMessage(message, overrides);
          })(),
    );

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: messages.map((message) => message.id),
      messages: toIdRecord(messages),
      updatedAt: now,
    }),
  );
}
