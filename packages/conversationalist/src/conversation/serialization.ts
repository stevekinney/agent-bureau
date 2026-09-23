import { createInvalidPositionError, createSerializationError } from '../errors';
import { conversationSchema } from '../schemas';
import type { AssistantMessage, ConversationHistory, Message, ToolResult } from '../types';
import { createMessage, isAssistantMessage, toReadonly } from '../utilities';
import { toIdRecord } from '../utilities/message-store';
import { assertConversationHistoryIntegrity } from './integrity';
import { assertToolReference, registerToolUse, type ToolUseIndex } from './tool-tracking';

function normalizeLegacyToolCall(toolCall: unknown): unknown {
  if (!isRecord(toolCall)) {
    return toolCall;
  }

  const record = { ...toolCall };

  if (!('arguments' in record) && 'args' in record) {
    record['arguments'] = record['args'];
  }

  delete record['args'];

  return record;
}

function normalizeLegacyToolResult(toolResult: unknown): unknown {
  if (!isRecord(toolResult)) {
    return toolResult;
  }

  const record = { ...toolResult };

  if (!('content' in record) && 'result' in record) {
    record['content'] = record['result'];
  }

  delete record['result'];

  return record;
}

function normalizeLegacyConversationData(json: unknown): unknown {
  if (!isRecord(json)) {
    return json;
  }

  const conversation = { ...json };
  if (!isRecord(conversation['messages'])) {
    return conversation;
  }
  conversation['messages'] = normalizeLegacyMessages(conversation['messages']);
  return conversation;
}

function normalizeLegacyMessages(messages: Record<string, unknown>): Record<string, unknown> {
  const normalizedMessages: Record<string, unknown> = {};
  for (const [messageId, messageValue] of Object.entries(messages)) {
    normalizedMessages[messageId] = normalizeLegacyMessage(messageValue);
  }
  return normalizedMessages;
}

function normalizeLegacyMessage(messageValue: unknown): unknown {
  if (!isRecord(messageValue)) return messageValue;
  const message = { ...messageValue };
  if (message['role'] === 'tool-use') message['role'] = 'tool-call';
  if ('toolCall' in message) message['toolCall'] = normalizeLegacyToolCall(message['toolCall']);
  if ('toolResult' in message) {
    message['toolResult'] = normalizeLegacyToolResult(message['toolResult']);
  }
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolResult(toolResult: Message['toolResult']): ToolResult | undefined {
  if (!toolResult) return undefined;
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content: toolResult.content,
    ...(toolResult.error ? { error: { ...toolResult.error } } : {}),
    ...(toolResult.action ? { action: { ...toolResult.action } } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

function normalizeMessage(message: Message): Message | AssistantMessage {
  const base: Message = {
    id: message.id,
    role: message.role,
    content: message.content,
    position: message.position,
    createdAt: message.createdAt,
    metadata: message.metadata,
    hidden: message.hidden,
    toolCall: message.toolCall ? { ...message.toolCall } : undefined,
    toolResult: normalizeToolResult(message.toolResult),
    tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : undefined,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    return {
      ...base,
      role: 'assistant',
      goalCompleted: message.goalCompleted,
    };
  }

  return base;
}

/**
 * Reconstructs a conversation from a JSON object.
 * Validates message positions are contiguous and tool results reference valid calls.
 * Throws a serialization error if validation fails.
 *
 * @param json - The conversation JSON to deserialize (may be from an older version)
 * @returns A ConversationHistory object
 * @throws {SerializationError} If validation fails
 */
export function deserializeConversationHistory(json: unknown): ConversationHistory {
  const parsed = conversationSchema.safeParse(normalizeLegacyConversationData(json));
  if (!parsed.success) {
    throw createSerializationError('failed to deserialize conversation: invalid data');
  }
  const data = parsed.data;

  try {
    const messageIds = new Set(Object.keys(data.messages));
    const orderedMessages = data.ids.map((id, index) => {
      const message = data.messages[id];
      if (!message) {
        throw createSerializationError(`missing message for id ${id}`);
      }
      if (message.position !== index) {
        throw createInvalidPositionError(index, message.position);
      }
      messageIds.delete(id);
      return normalizeMessage(message);
    });

    if (messageIds.size > 0) {
      throw createSerializationError(`messages not listed in ids: ${[...messageIds].join(', ')}`);
    }

    orderedMessages.reduce<{ toolUses: ToolUseIndex }>(
      (state, message) => {
        if (message.role === 'tool-call' && message.toolCall) {
          return {
            toolUses: registerToolUse(state.toolUses, message.toolCall),
          };
        }

        if (message.role === 'tool-result' && message.toolResult) {
          assertToolReference(state.toolUses, message.toolResult.callId);
        }

        return state;
      },
      { toolUses: new Map<string, { name: string }>() },
    );

    const messageInstances: Message[] = orderedMessages.map((message) => createMessage(message));
    const conv: ConversationHistory = {
      schemaVersion: data.schemaVersion,
      id: data.id,
      title: data.title,
      status: data.status,
      metadata: { ...data.metadata },
      ids: orderedMessages.map((message) => message.id),
      messages: toIdRecord(messageInstances),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    const readonly = toReadonly(conv);
    assertConversationHistoryIntegrity(readonly);
    return readonly;
  } catch (error) {
    throw createSerializationError(
      `failed to deserialize conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined,
    );
  }
}
