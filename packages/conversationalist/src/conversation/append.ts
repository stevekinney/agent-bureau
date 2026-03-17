import type { MultiModalContent } from '@lasercat/homogenaize';

import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createIntegrityError } from '../errors';
import type {
  AssistantMessage,
  Conversation,
  JSONValue,
  Message,
  MessageInput,
} from '../types';
import { createMessage, normalizeContent, toReadonly } from '../utilities';
import { getOrderedMessages, toIdRecord } from '../utilities/message-store';
import {
  assertToolReference,
  buildToolUseIndex,
  registerToolUse,
  type ToolUseIndex,
} from './tool-tracking';
import { ensureConversationSafe } from './validation';

/**
 * Separates message inputs from an optional trailing environment argument.
 */
function partitionAppendArgs(
  args: Array<MessageInput | Partial<ConversationEnvironment> | undefined>,
): {
  inputs: MessageInput[];
  environment?: Partial<ConversationEnvironment> | undefined;
} {
  const filtered = args.filter((arg) => arg !== undefined);

  if (filtered.length === 0) {
    return { inputs: [] };
  }

  const last = filtered[filtered.length - 1];
  if (isConversationEnvironmentParameter(last)) {
    return {
      inputs: filtered.slice(0, -1) as MessageInput[],
      environment: last,
    };
  }

  return { inputs: filtered as MessageInput[] };
}

/**
 * Appends one or more messages to a conversation.
 * Validates that tool results reference existing function calls.
 * Returns a new immutable conversation with the messages added.
 */
export function appendMessages(
  conversation: Conversation,
  ...inputs: MessageInput[]
): Conversation;
export function appendMessages(
  conversation: Conversation,
  ...inputsAndEnvironment: [
    ...MessageInput[],
    Partial<ConversationEnvironment> | undefined,
  ]
): Conversation;
export function appendMessages(
  conversation: Conversation,
  ...args: (MessageInput | Partial<ConversationEnvironment> | undefined)[]
): Conversation {
  return appendMessagesInternal(conversation, args, true);
}

/**
 * Appends a message without validating conversation integrity or JSON-safety.
 * Use only when you have already validated the conversation yourself.
 */
export function appendUnsafeMessage(
  conversation: Conversation,
  input: MessageInput,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return appendMessagesInternal(conversation, [input, environment], false);
}

const appendMessagesInternal = (
  conversation: Conversation,
  args: Array<MessageInput | Partial<ConversationEnvironment> | undefined>,
  validate: boolean,
): Conversation => {
  const { inputs, environment } = partitionAppendArgs(args);
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();
  const startPosition = conversation.ids.length;
  const initialToolUses = validate
    ? buildToolUseIndex(getOrderedMessages(conversation))
    : new Map<string, { name: string }>();

  const { messages } = inputs.reduce<{
    toolUses: ToolUseIndex;
    messages: Message[];
  }>(
    (state, input, index) => {
      const processedInput = resolvedEnvironment.plugins.reduce(
        (acc, plugin) => plugin(acc),
        input,
      );

      if (
        validate &&
        processedInput.role === 'tool-result' &&
        processedInput.toolResult
      ) {
        assertToolReference(state.toolUses, processedInput.toolResult.callId);
      }

      const normalizedContent = normalizeContent(processedInput.content) as
        | string
        | MultiModalContent[];

      const baseMessage = {
        id: resolvedEnvironment.randomId(),
        role: processedInput.role,
        content: normalizedContent,
        position: startPosition + index,
        createdAt: now,
        metadata: { ...(processedInput.metadata ?? {}) },
        hidden: processedInput.hidden ?? false,
        toolCall: processedInput.toolCall,
        toolResult: processedInput.toolResult,
        tokenUsage: processedInput.tokenUsage,
      };

      let message: Message;
      if (processedInput.role === 'assistant') {
        const assistantMessage: AssistantMessage = {
          ...baseMessage,
          role: 'assistant',
          goalCompleted: processedInput.goalCompleted,
        };
        message = createMessage(assistantMessage);
      } else {
        message = createMessage(baseMessage);
      }

      let toolUses = state.toolUses;
      if (processedInput.role === 'tool-use' && processedInput.toolCall) {
        if (validate && state.toolUses.has(processedInput.toolCall.id)) {
          throw createIntegrityError('duplicate toolCall.id in conversation', {
            toolCallId: processedInput.toolCall.id,
            messageId: baseMessage.id,
          });
        }

        toolUses = validate
          ? registerToolUse(state.toolUses, processedInput.toolCall)
          : state.toolUses;
      }

      return {
        toolUses,
        messages: [...state.messages, message],
      };
    },
    { toolUses: initialToolUses, messages: [] },
  );

  const messageIds = messages.map((message) => message.id);
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids, ...messageIds],
    messages: { ...conversation.messages, ...toIdRecord(messages) },
    updatedAt: now,
  };
  const readonly = toReadonly(next);
  return validate ? ensureConversationSafe(readonly) : readonly;
};

/**
 * Appends a user message to the conversation.
 */
export function appendUserMessage(
  conversation: Conversation,
  content: MessageInput['content'],
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata)
    ? metadata
    : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata)
    ? undefined
    : metadata;
  return appendMessages(
    conversation,
    { role: 'user', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}

/**
 * Appends an assistant message to the conversation.
 */
export function appendAssistantMessage(
  conversation: Conversation,
  content: MessageInput['content'],
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata)
    ? metadata
    : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata)
    ? undefined
    : metadata;
  return appendMessages(
    conversation,
    { role: 'assistant', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}

/**
 * Appends a system message to the conversation.
 */
export function appendSystemMessage(
  conversation: Conversation,
  content: string,
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata)
    ? metadata
    : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata)
    ? undefined
    : metadata;
  return appendMessages(
    conversation,
    { role: 'system', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}
