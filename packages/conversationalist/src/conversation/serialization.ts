import { createInvalidPositionError, createSerializationError } from '../errors';
import { conversationSchema } from '../schemas';
import type { AssistantMessage, Conversation, Message, ToolResult } from '../types';
import { createMessage, isAssistantMessage, toReadonly } from '../utilities';
import { toIdRecord } from '../utilities/message-store';
import { assertConversationIntegrity } from './integrity';
import { assertToolReference, registerToolUse, type ToolUseIndex } from './tool-tracking';

function normalizeToolResult(toolResult: Message['toolResult']): ToolResult | undefined {
  if (!toolResult) return undefined;
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content: toolResult.content,
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
 * @returns A Conversation object
 * @throws {SerializationError} If validation fails
 */
export function deserializeConversation(json: unknown): Conversation {
  const parsed = conversationSchema.safeParse(json);
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
      throw createSerializationError(
        `messages not listed in ids: ${[...messageIds].join(', ')}`,
      );
    }

    orderedMessages.reduce<{ toolUses: ToolUseIndex }>(
      (state, message) => {
        if (message.role === 'tool-use' && message.toolCall) {
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

    const messageInstances: Message[] = orderedMessages.map((message) =>
      createMessage(message),
    );
    const conv: Conversation = {
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
    assertConversationIntegrity(readonly);
    return readonly;
  } catch (error) {
    throw createSerializationError(
      `failed to deserialize conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error as Error,
    );
  }
}
