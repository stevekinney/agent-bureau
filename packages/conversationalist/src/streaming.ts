import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from './environment';
import type { MultiModalContent } from './multi-modal';
import type {
  AssistantMessage,
  ConversationHistory as Conversation,
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
      (typeof original.content === 'string' ? original.content : [...original.content]),
    position: overrides.position ?? original.position,
    createdAt: original.createdAt,
    metadata: overrides.metadata ?? { ...original.metadata },
    hidden: original.hidden,
    toolCall: original.toolCall ? { ...original.toolCall } : undefined,
    toolResult: original.toolResult ? { ...original.toolResult } : undefined,
    tokenUsage: overrides.tokenUsage,
    cacheBoundary: original.cacheBoundary,
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
  return appendStreamingMessageInternal(conversation, role, metadata, environment, true);
}

/**
 * Creates a pending/streaming message placeholder without validating the
 * resulting conversation. Use only for render-side projections that can contain
 * structurally incomplete tool-call/tool-result pairs.
 */
export function appendUnsafeStreamingMessage(
  conversation: Conversation,
  role: 'assistant' | 'user',
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): { conversation: Conversation; messageId: string } {
  return appendStreamingMessageInternal(conversation, role, metadata, environment, false);
}

const appendStreamingMessageInternal = (
  conversation: Conversation,
  role: 'assistant' | 'user',
  metadata: Record<string, JSONValue> | Partial<ConversationEnvironment> | undefined,
  environment: Partial<ConversationEnvironment> | undefined,
  validate: boolean,
): { conversation: Conversation; messageId: string } => {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(metadata) ? metadata : environment,
  );
  const resolvedMetadata = isConversationEnvironmentParameter(metadata) ? undefined : metadata;
  const now = resolvedEnvironment.now();
  const messageId = resolvedEnvironment.randomId();

  const newMessage = createMessage({
    id: messageId,
    role,
    content: '',
    position: conversation.ids.length,
    createdAt: now,
    metadata: { ...resolvedMetadata, [STREAMING_KEY]: true },
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

  return {
    conversation: validate ? ensureConversationSafe(updatedConversation) : updatedConversation,
    messageId,
  };
};

/**
 * Updates the content of a streaming message.
 * This replaces the existing content (use for accumulating streamed tokens).
 *
 * Only a message that is still streaming accepts streamed content: if
 * `messageId` is unknown, or names a message that has already been finalized by
 * {@link finalizeStreamingMessage}, the conversation is returned unchanged. That
 * makes the late-token race — a chunk arriving after the user hits stop — a
 * no-op instead of silently growing a message the UI already presented as final.
 * Use {@link updateUnsafeStreamingMessage} when you deliberately need to write
 * content to a non-streaming message.
 */
export function updateStreamingMessage(
  conversation: Conversation,
  messageId: string,
  content: string | MultiModalContent[],
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return updateStreamingMessageInternal(conversation, messageId, content, environment, true);
}

/**
 * Updates a streaming message without validating the resulting conversation,
 * and without requiring the target message to still be streaming.
 * Use only for render-side projections that can contain structurally incomplete
 * tool-call/tool-result pairs, or that reproject content onto a message whose
 * streaming flag has already been cleared. This is the documented escape hatch
 * from the streaming-status guard on {@link updateStreamingMessage}.
 */
export function updateUnsafeStreamingMessage(
  conversation: Conversation,
  messageId: string,
  content: string | MultiModalContent[],
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return updateStreamingMessageInternal(conversation, messageId, content, environment, false);
}

const updateStreamingMessageInternal = (
  conversation: Conversation,
  messageId: string,
  content: string | MultiModalContent[],
  environment: Partial<ConversationEnvironment> | undefined,
  validate: boolean,
): Conversation => {
  const original = conversation.messages[messageId];
  if (!original) {
    return validate ? ensureConversationSafe(conversation) : conversation;
  }

  // Lifecycle guard for the safe variant: only a streaming placeholder accepts
  // streamed content. Without this, a token that lands after
  // finalizeStreamingMessage grows a message the UI already froze. A cancelled
  // message is removed outright, so that race falls into the branch above; this
  // covers the post-finalize half. No-op rather than throw, so the two halves of
  // the same race behave identically and a stop-button race cannot crash a
  // stream. `updateUnsafeStreamingMessage` (validate === false) opts out.
  if (validate && !isStreamingMessage(original)) {
    return ensureConversationSafe(conversation);
  }

  // Resolved only once the update is known to apply: a rejected late token must
  // not consume a tick from a stateful injected clock, nor propagate a throw
  // from a fallible one.
  const now = resolveConversationEnvironment(environment).now();

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
  const updatedConversation = toReadonly({
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [updated.id]: updated },
    updatedAt: now,
  });

  return validate ? ensureConversationSafe(updatedConversation) : updatedConversation;
};

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
  return finalizeStreamingMessageInternal(conversation, messageId, options, environment, true);
}

/**
 * Finalizes a streaming message without validating the resulting conversation.
 * Use only for render-side projections that can contain structurally incomplete
 * tool-call/tool-result pairs.
 */
export function finalizeUnsafeStreamingMessage(
  conversation: Conversation,
  messageId: string,
  options?:
    | {
        tokenUsage?: TokenUsage;
        metadata?: Record<string, JSONValue>;
      }
    | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return finalizeStreamingMessageInternal(conversation, messageId, options, environment, false);
}

const finalizeStreamingMessageInternal = (
  conversation: Conversation,
  messageId: string,
  options:
    | {
        tokenUsage?: TokenUsage;
        metadata?: Record<string, JSONValue>;
      }
    | Partial<ConversationEnvironment>
    | undefined,
  environment: Partial<ConversationEnvironment> | undefined,
  validate: boolean,
): Conversation => {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const now = resolvedEnvironment.now();

  const original = conversation.messages[messageId];
  if (!original) {
    return validate ? ensureConversationSafe(conversation) : conversation;
  }

  // Remove the streaming flag and merge in any new metadata
  const { [STREAMING_KEY]: _, ...restMetadata } = original.metadata as Record<string, JSONValue>;
  const finalMetadata: Record<string, JSONValue> = {
    ...restMetadata,
    ...resolvedOptions?.metadata,
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
  const updatedConversation = toReadonly({
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [updated.id]: updated },
    updatedAt: now,
  });

  return validate ? ensureConversationSafe(updatedConversation) : updatedConversation;
};

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
