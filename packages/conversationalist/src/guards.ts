import type { MultiModalContent } from './multi-modal';
import {
  conversationSchema,
  conversationStatusSchema,
  jsonValueSchema,
  messageInputSchema,
  messageRoleSchema,
  messageSchema,
  multiModalContentSchema,
  tokenUsageSchema,
  toolCallSchema,
  toolResultSchema,
} from './schemas';
import type {
  Conversation,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToolCall,
  ToolResult,
} from './types';

type SchemaGuard = {
  safeParse: (value: unknown) => { success: boolean };
};

function isSchema<T>(schema: SchemaGuard, value: unknown): value is T {
  return schema.safeParse(value).success;
}

export function isConversation(value: unknown): value is Conversation {
  return isSchema(conversationSchema, value);
}

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return isSchema(conversationStatusSchema, value);
}

export function isJSONValue(value: unknown): value is JSONValue {
  return isSchema(jsonValueSchema, value);
}

export function isMessage(value: unknown): value is Message {
  return isSchema(messageSchema, value);
}

export function isMessageInput(value: unknown): value is MessageInput {
  return isSchema(messageInputSchema, value);
}

export function isMessageRole(value: unknown): value is MessageRole {
  return isSchema(messageRoleSchema, value);
}

export function isMultiModalContent(value: unknown): value is MultiModalContent {
  return isSchema(multiModalContentSchema, value);
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  return isSchema(tokenUsageSchema, value);
}

export function isToolCall(value: unknown): value is ToolCall {
  return isSchema(toolCallSchema, value);
}

export function isToolResult(value: unknown): value is ToolResult {
  return isSchema(toolResultSchema, value);
}
