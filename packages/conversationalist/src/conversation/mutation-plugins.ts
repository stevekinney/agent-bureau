import type { ConversationEnvironment } from '../environment';
import { createInvalidInputError } from '../errors';
import type { Message, MessageInput, ToolResult } from '../types';
import { createMessage, hasOwnProperty, isAssistantMessage } from '../utilities';

/** Message fields that can be changed without changing message identity or order. */
export type MessageUpdate = Partial<
  Pick<Message, 'content' | 'metadata' | 'hidden' | 'tokenUsage' | 'cacheBoundary'>
>;

export type InternalMessageUpdate = MessageUpdate & { toolResult?: ToolResult | undefined };

const arePluginValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return arePluginArraysEqual(left, right);
  }

  const leftEntries: [string, unknown][] = Object.entries(left);
  const rightEntries: [string, unknown][] = Object.entries(right);
  const rightValues = new Map(rightEntries);
  return (
    leftEntries.length === rightValues.size &&
    leftEntries.every(
      ([key, value]) => rightValues.has(key) && arePluginValuesEqual(value, rightValues.get(key)),
    )
  );
};

function arePluginArraysEqual(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => arePluginValuesEqual(value, right[index]))
  );
}

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

function processPluginInput(
  createInput: () => MessageInput,
  messageId: string,
  environment: ConversationEnvironment,
): MessageInput {
  const applyPlugins = (input: MessageInput): MessageInput =>
    environment.plugins.reduce((current, plugin) => plugin(current), input);
  const processedInput = applyPlugins(createInput());
  const repeatedInput = applyPlugins(createInput());
  if (!arePluginValuesEqual(processedInput, repeatedInput)) {
    throw createInvalidInputError(
      'Message plugins must return deterministic output for transcript mutations',
      { messageId },
    );
  }
  const reprocessedInput = applyPlugins(structuredClone(processedInput));
  if (!arePluginValuesEqual(processedInput, reprocessedInput)) {
    throw createInvalidInputError(
      'Message plugins must return idempotent output for transcript mutations',
      { messageId },
    );
  }
  return processedInput;
}

function assertPreservedToolCallIdentity(message: Message, processedInput: MessageInput): void {
  const expectedToolCallId = message.toolCall?.id;
  if (expectedToolCallId !== undefined && processedInput.toolCall?.id !== expectedToolCallId) {
    throw createInvalidInputError(
      `Processed toolCall.id (${processedInput.toolCall?.id ?? 'missing'}) does not match the preserved id (${expectedToolCallId})`,
      {
        messageId: message.id,
        expectedToolCallId,
        processedToolCallId: processedInput.toolCall?.id,
      },
    );
  }
}

function assertPreservedToolResultIdentity(
  message: Message,
  updates: InternalMessageUpdate,
  processedInput: MessageInput,
): void {
  const expectedToolResultCallId = updates.toolResult?.callId ?? message.toolResult?.callId;
  if (
    expectedToolResultCallId !== undefined &&
    processedInput.toolResult?.callId !== expectedToolResultCallId
  ) {
    throw createInvalidInputError(
      `Processed toolResult.callId (${processedInput.toolResult?.callId ?? 'missing'}) does not match the preserved callId (${expectedToolResultCallId})`,
      {
        messageId: message.id,
        expectedCallId: expectedToolResultCallId,
        processedCallId: processedInput.toolResult?.callId,
      },
    );
  }
}

export const createUpdatedMessage = (
  message: Message,
  updates: InternalMessageUpdate,
  environment: ConversationEnvironment,
): Message => {
  processPluginInput(() => createPluginInput(message, {}), message.id, environment);
  const processedInput = processPluginInput(
    () => createPluginInput(message, updates),
    message.id,
    environment,
  );
  assertPreservedToolCallIdentity(message, processedInput);
  assertPreservedToolResultIdentity(message, updates, processedInput);
  const updated = {
    id: message.id,
    content: processedInput.content,
    position: message.position,
    createdAt: message.createdAt,
    metadata: { ...processedInput.metadata },
    hidden: processedInput.hidden ?? false,
    toolCall: processedInput.toolCall,
    toolResult: processedInput.toolResult,
    tokenUsage: processedInput.tokenUsage,
    cacheBoundary: processedInput.cacheBoundary,
  };

  return isAssistantMessage(message)
    ? createMessage({ ...updated, role: 'assistant', goalCompleted: message.goalCompleted })
    : createMessage({ ...updated, role: message.role });
};
