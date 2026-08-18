import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createInvalidInputError, createInvalidPositionError } from '../errors';
import type {
  ConversationHistory as Conversation,
  Message,
  MessageInput,
  ToolResult,
} from '../types';
import {
  createMessage,
  hasOwnProperty,
  isAssistantMessage,
  repositionMessage,
  toReadonly,
} from '../utilities';
import { redactToolResult } from '../utilities/tool-results';
import { ensureConversationSafe } from './validation';

/** Message fields that can be changed without changing message identity or order. */
export type MessageUpdate = Partial<
  Pick<Message, 'content' | 'metadata' | 'hidden' | 'tokenUsage' | 'cacheBoundary'>
>;

type InternalMessageUpdate = MessageUpdate & { toolResult?: ToolResult | undefined };

const arePluginValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => arePluginValuesEqual(value, right[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        hasOwnProperty(rightRecord, key) && arePluginValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
};

const createPluginInput = (message: Message, updates: InternalMessageUpdate): MessageInput => {
  const content = updates.content ?? message.content;
  return {
    role: message.role,
    content: typeof content === 'string' ? content : structuredClone([...content]),
    metadata: structuredClone(updates.metadata ?? message.metadata),
    hidden: updates.hidden ?? message.hidden,
    goalCompleted: isAssistantMessage(message) ? message.goalCompleted : undefined,
    toolCall: message.toolCall ? structuredClone(message.toolCall) : undefined,
    toolResult: structuredClone(updates.toolResult ?? message.toolResult),
    tokenUsage: structuredClone(
      hasOwnProperty(updates, 'tokenUsage') ? updates.tokenUsage : message.tokenUsage,
    ),
    cacheBoundary: hasOwnProperty(updates, 'cacheBoundary')
      ? updates.cacheBoundary
      : message.cacheBoundary,
  };
};

const createUpdatedMessage = (
  message: Message,
  updates: InternalMessageUpdate,
  environment: ConversationEnvironment,
): Message => {
  const applyPlugins = (input: MessageInput): MessageInput =>
    environment.plugins.reduce((current, plugin) => plugin(current), input);
  const baselineInput = applyPlugins(createPluginInput(message, {}));
  const repeatedBaselineInput = applyPlugins(createPluginInput(message, {}));
  if (!arePluginValuesEqual(baselineInput, repeatedBaselineInput)) {
    throw createInvalidInputError(
      'Message plugins must return deterministic output for transcript mutations',
      { messageId: message.id },
    );
  }
  const processedInput = applyPlugins(createPluginInput(message, updates));
  const repeatedProcessedInput = applyPlugins(createPluginInput(message, updates));
  if (!arePluginValuesEqual(processedInput, repeatedProcessedInput)) {
    throw createInvalidInputError(
      'Message plugins must return deterministic output for transcript mutations',
      { messageId: message.id },
    );
  }
  const expectedToolResultCallId = updates.toolResult?.callId ?? message.toolResult?.callId;
  if (expectedToolResultCallId && processedInput.toolResult?.callId !== expectedToolResultCallId) {
    throw createInvalidInputError(
      `Processed toolResult.callId (${processedInput.toolResult?.callId ?? 'missing'}) does not match the preserved callId (${expectedToolResultCallId})`,
      {
        messageId: message.id,
        expectedCallId: expectedToolResultCallId,
        processedCallId: processedInput.toolResult?.callId,
      },
    );
  }
  const pluginChanged = (field: keyof MessageInput): boolean =>
    !arePluginValuesEqual(baselineInput[field], processedInput[field]);
  const updated = {
    id: message.id,
    content:
      updates.content !== undefined || pluginChanged('content')
        ? processedInput.content
        : message.content,
    position: message.position,
    createdAt: message.createdAt,
    metadata:
      updates.metadata !== undefined || pluginChanged('metadata')
        ? { ...(processedInput.metadata ?? {}) }
        : message.metadata,
    hidden:
      updates.hidden !== undefined || pluginChanged('hidden')
        ? (processedInput.hidden ?? false)
        : message.hidden,
    toolCall: message.toolCall,
    toolResult:
      hasOwnProperty(updates, 'toolResult') || pluginChanged('toolResult')
        ? processedInput.toolResult
        : message.toolResult,
    tokenUsage:
      hasOwnProperty(updates, 'tokenUsage') || pluginChanged('tokenUsage')
        ? processedInput.tokenUsage
        : message.tokenUsage,
    cacheBoundary:
      hasOwnProperty(updates, 'cacheBoundary') || pluginChanged('cacheBoundary')
        ? processedInput.cacheBoundary
        : message.cacheBoundary,
  };

  return isAssistantMessage(message)
    ? createMessage({ ...updated, role: 'assistant', goalCompleted: message.goalCompleted })
    : createMessage({ ...updated, role: message.role });
};

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

export interface RedactMessageOptions {
  placeholder?: string;
  redactToolArguments?: boolean;
  redactToolResults?: boolean;
  clearToolMetadata?: boolean;
}

const isRedactMessageOptions = (value: unknown): value is RedactMessageOptions => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    'placeholder' in candidate ||
    'redactToolArguments' in candidate ||
    'redactToolResults' in candidate ||
    'clearToolMetadata' in candidate
  );
};

/**
 * Replaces the content of a message at the specified position with a placeholder.
 * By default preserves tool identifiers/outcomes while redacting tool payloads.
 * Throws if the position is out of bounds.
 */
export function redactMessageAtPosition(
  conversation: Conversation,
  position: number,
  placeholderOrOptions?: string | RedactMessageOptions | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  let placeholder = '[REDACTED]';
  let options: RedactMessageOptions = {};
  let env = environment;

  if (typeof placeholderOrOptions === 'string') {
    placeholder = placeholderOrOptions;
  } else if (placeholderOrOptions) {
    if (!environment && isConversationEnvironmentParameter(placeholderOrOptions)) {
      env = placeholderOrOptions;
    } else if (isRedactMessageOptions(placeholderOrOptions)) {
      options = placeholderOrOptions;
      if (options.placeholder) {
        placeholder = options.placeholder;
      }
    }
  }

  const redactToolArguments = options.redactToolArguments ?? true;
  const redactToolResults = options.redactToolResults ?? true;
  const clearToolMetadata = options.clearToolMetadata ?? false;

  if (position < 0 || position >= conversation.ids.length) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  const id = conversation.ids[position];
  const original = id ? conversation.messages[id] : undefined;
  if (!original) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  let toolCall = original.toolCall ? { ...original.toolCall } : undefined;
  let toolResult = original.toolResult ? { ...original.toolResult } : undefined;

  if (clearToolMetadata) {
    toolCall = undefined;
    toolResult = undefined;
  } else {
    if (original.role === 'tool-call' && toolCall) {
      toolCall = {
        ...toolCall,
        arguments: redactToolArguments ? placeholder : toolCall.arguments,
      };
    }

    if (original.role === 'tool-result' && toolResult) {
      toolResult = redactToolResults
        ? redactToolResult(toolResult, placeholder)
        : { ...toolResult };
    }
  }

  const redacted: Message = createMessage({
    id: original.id,
    role: original.role,
    content: placeholder,
    position: original.position,
    createdAt: original.createdAt,
    metadata: { ...original.metadata },
    hidden: original.hidden,
    toolCall,
    toolResult,
    tokenUsage: original.tokenUsage ? { ...original.tokenUsage } : undefined,
    cacheBoundary: original.cacheBoundary,
  });

  const resolvedEnvironment = resolveConversationEnvironment(env);
  const now = resolvedEnvironment.now();
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [redacted.id]: redacted },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}
