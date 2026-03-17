import type { MultiModalContent } from '@lasercat/homogenaize';

import { truncateFromPosition, truncateToTokenLimit } from './context';
import type { RedactMessageOptions } from './conversation/index';
import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  collapseSystemMessages,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
} from './conversation/index';
import { ensureConversationSafe } from './conversation/validation';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from './streaming';
import type { Conversation, JSONValue, Message, MessageInput, TokenUsage } from './types';

/**
 * A mutable draft wrapper around a conversation.
 * Methods return the draft for chaining and mutate the internal state.
 *
 * @example
 * ```ts
 * const result = withConversation(conversation, (draft) => {
 *   draft
 *     .appendSystemMessage('You are helpful.')
 *     .appendUserMessage('Hello!')
 *     .appendAssistantMessage('Hi there!');
 * });
 * ```
 */
export interface ConversationDraft {
  /** The current immutable conversation value. */
  readonly value: Conversation;

  /**
   * Appends one or more messages to the conversation.
   * @param inputs - Message inputs to append.
   */
  appendMessages: (...inputs: MessageInput[]) => ConversationDraft;

  /**
   * Appends a user message to the conversation.
   * @param content - Text or multi-modal content.
   * @param metadata - Optional metadata to attach to the message.
   */
  appendUserMessage: (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ) => ConversationDraft;

  /**
   * Appends an assistant message to the conversation.
   * @param content - Text or multi-modal content.
   * @param metadata - Optional metadata to attach to the message.
   */
  appendAssistantMessage: (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ) => ConversationDraft;

  /**
   * Appends a system message to the conversation.
   * @param content - The system message content.
   * @param metadata - Optional metadata to attach to the message.
   */
  appendSystemMessage: (
    content: string,
    metadata?: Record<string, JSONValue>,
  ) => ConversationDraft;

  /**
   * Prepends a system message at position 0, renumbering existing messages.
   * @param content - The system message content.
   * @param metadata - Optional metadata to attach to the message.
   */
  prependSystemMessage: (
    content: string,
    metadata?: Record<string, JSONValue>,
  ) => ConversationDraft;

  /**
   * Replaces the first system message, or prepends if none exists.
   * @param content - The new system message content.
   * @param metadata - Optional metadata (uses original if not provided).
   */
  replaceSystemMessage: (
    content: string,
    metadata?: Record<string, JSONValue>,
  ) => ConversationDraft;

  /**
   * Collapses all system messages into the first one, deduplicating content.
   */
  collapseSystemMessages: () => ConversationDraft;

  /**
   * Redacts a message at the given position, replacing its content.
   * @param position - The message position to redact.
   * @param placeholder - Replacement text (default: '[REDACTED]').
   */
  redactMessageAtPosition: (
    position: number,
    placeholderOrOptions?: string | RedactMessageOptions,
  ) => ConversationDraft;

  /**
   * Appends a streaming message placeholder.
   * Returns the draft and the new message ID for subsequent updates.
   * @param role - The role of the streaming message ('assistant' or 'user').
   * @param metadata - Optional metadata to attach to the message.
   */
  appendStreamingMessage: (
    role: 'assistant' | 'user',
    metadata?: Record<string, JSONValue>,
  ) => { draft: ConversationDraft; messageId: string };

  /**
   * Updates the content of a streaming message.
   * @param messageId - The ID of the streaming message to update.
   * @param content - The new content (replaces existing content).
   */
  updateStreamingMessage: (
    messageId: string,
    content: string | MultiModalContent[],
  ) => ConversationDraft;

  /**
   * Finalizes a streaming message, removing the streaming flag.
   * @param messageId - The ID of the streaming message to finalize.
   * @param options - Optional token usage and additional metadata.
   */
  finalizeStreamingMessage: (
    messageId: string,
    options?: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> },
  ) => ConversationDraft;

  /**
   * Cancels a streaming message by removing it from the conversation.
   * @param messageId - The ID of the streaming message to cancel.
   */
  cancelStreamingMessage: (messageId: string) => ConversationDraft;

  /**
   * Truncates the conversation to keep only messages from position onwards.
   * @param position - The starting position to keep.
   * @param options - Options for preserving system messages.
   */
  truncateFromPosition: (
    position: number,
    options?: { preserveSystemMessages?: boolean; preserveToolPairs?: boolean },
  ) => ConversationDraft;

  /**
   * Truncates the conversation to fit within a token limit.
   * Removes oldest messages first while preserving system messages and optionally the last N messages.
   * @param maxTokens - Maximum token count to target.
   * @param options - Options for estimation and preservation.
   */
  truncateToTokenLimit: (
    maxTokens: number,
    options?: {
      estimateTokens?: (message: Message) => number;
      preserveSystemMessages?: boolean;
      preserveLastN?: number;
      preserveToolPairs?: boolean;
    },
  ) => ConversationDraft;
}

/**
 * Creates a mutable draft wrapper around a conversation.
 */
function createDraft(initial: Conversation): ConversationDraft {
  let current = initial;

  const draft: ConversationDraft = {
    get value() {
      return current;
    },

    // Message appending
    appendMessages: (...inputs: MessageInput[]) => {
      current = appendMessages(current, ...inputs);
      return draft;
    },
    appendUserMessage: (content, metadata) => {
      current = appendUserMessage(current, content, metadata);
      return draft;
    },
    appendAssistantMessage: (content, metadata) => {
      current = appendAssistantMessage(current, content, metadata);
      return draft;
    },
    appendSystemMessage: (content, metadata) => {
      current = appendSystemMessage(current, content, metadata);
      return draft;
    },

    // System message management
    prependSystemMessage: (content, metadata) => {
      current = prependSystemMessage(current, content, metadata);
      return draft;
    },
    replaceSystemMessage: (content, metadata) => {
      current = replaceSystemMessage(current, content, metadata);
      return draft;
    },
    collapseSystemMessages: () => {
      current = collapseSystemMessages(current);
      return draft;
    },

    // Message modification
    redactMessageAtPosition: (position, placeholderOrOptions) => {
      current = redactMessageAtPosition(current, position, placeholderOrOptions);
      return draft;
    },

    // Streaming support
    appendStreamingMessage: (role, metadata) => {
      const result = appendStreamingMessage(current, role, metadata);
      current = result.conversation;
      return { draft, messageId: result.messageId };
    },
    updateStreamingMessage: (messageId, content) => {
      current = updateStreamingMessage(current, messageId, content);
      return draft;
    },
    finalizeStreamingMessage: (messageId, options) => {
      current = finalizeStreamingMessage(current, messageId, options);
      return draft;
    },
    cancelStreamingMessage: (messageId) => {
      current = cancelStreamingMessage(current, messageId);
      return draft;
    },

    // Context window management
    truncateFromPosition: (position, options) => {
      current = truncateFromPosition(current, position, options);
      return draft;
    },
    truncateToTokenLimit: (maxTokens, options) => {
      current = truncateToTokenLimit(current, maxTokens, options);
      return draft;
    },
  };

  return draft;
}

/**
 * Executes a function with a mutable draft and returns the final conversation.
 * Supports both synchronous and asynchronous operations.
 */
export function withConversation(
  conversation: Conversation,
  fn: (draft: ConversationDraft) => void | Promise<void>,
): Conversation | Promise<Conversation> {
  const draft = createDraft(ensureConversationSafe(conversation));
  const maybePromise = fn(draft);
  if (
    maybePromise &&
    typeof (maybePromise as unknown) === 'object' &&
    typeof maybePromise.then === 'function'
  ) {
    return maybePromise.then(() => ensureConversationSafe(draft.value));
  }
  return ensureConversationSafe(draft.value);
}

/**
 * Applies a series of transformation functions to a conversation.
 * Each function receives the result of the previous one.
 */
export function pipeConversation(
  conversation: Conversation,
  ...fns: Array<(conversation: Conversation) => Conversation>
): Conversation {
  const result = fns.reduce((current, fn) => fn(current), conversation);
  return ensureConversationSafe(result);
}
