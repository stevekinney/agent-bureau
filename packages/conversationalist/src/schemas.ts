import type { MultiModalContent } from '@lasercat/homogenaize';
import { z } from 'zod';

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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type RawMultiModalContent = {
  type: 'text' | 'image';
  text?: string | undefined;
  url?: string | undefined;
  mimeType?: string | undefined;
};

function toMultiModalContent(value: RawMultiModalContent): MultiModalContent {
  const result: MultiModalContent = { type: value.type };
  if (value.text !== undefined) result.text = value.text;
  if (value.url !== undefined) result.url = value.url;
  if (value.mimeType !== undefined) result.mimeType = value.mimeType;
  return result;
}

/**
 * Zod schema for JSON-serializable values.
 */
export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() => {
  const jsonObjectSchema = z.preprocess(
    (value, ctx) => {
      if (!isPlainObject(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'expected a plain object',
        });
        return z.NEVER;
      }
      return value;
    },
    z.record(z.string(), jsonValueSchema),
  );

  return z.union([
    z.string(),
    z.number().refine((value) => Number.isFinite(value), {
      message: 'expected a finite number',
    }),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    jsonObjectSchema,
  ]);
}) satisfies z.ZodType<JSONValue>;

/**
 * Zod schema for multi-modal content parts (text or image).
 */
export const multiModalContentSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
    z.object({
      type: z.literal('image'),
      url: z.string().url(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
    }),
  ])
  .transform(toMultiModalContent) satisfies z.ZodType<MultiModalContent>;

/**
 * Zod schema for valid message roles.
 */
export const messageRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'developer',
  'tool-use',
  'tool-result',
  'snapshot',
]) satisfies z.ZodType<MessageRole>;

/**
 * Zod schema for tool call metadata.
 */
export const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: jsonValueSchema,
  })
  .strict() satisfies z.ZodType<ToolCall>;

/**
 * Zod schema for tool result metadata.
 */
export const toolResultSchema = z
  .object({
    callId: z.string(),
    outcome: z.enum(['success', 'error']),
    content: jsonValueSchema,
  })
  .strict() satisfies z.ZodType<ToolResult>;

/**
 * Zod schema for token usage accounting.
 */
export const tokenUsageSchema = z.object({
  prompt: z.number().int().min(0),
  completion: z.number().int().min(0),
  total: z.number().int().min(0),
}) satisfies z.ZodType<TokenUsage>;

/**
 * Zod schema for message input payloads.
 */
export const messageInputSchema = z
  .object({
    role: messageRoleSchema,
    content: z.union([z.string(), z.array(multiModalContentSchema)]),
    metadata: z.record(z.string(), jsonValueSchema).optional(),
    hidden: z.boolean().optional(),
    toolCall: toolCallSchema.optional(),
    toolResult: toolResultSchema.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    goalCompleted: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<MessageInput>;

/**
 * Zod schema for messages.
 */
export const messageSchema = z
  .object({
    id: z.string(),
    role: messageRoleSchema,
    content: z.union([z.string(), z.array(multiModalContentSchema)]),
    position: z.number().int().min(0),
    createdAt: z.string(),
    metadata: z.record(z.string(), jsonValueSchema),
    hidden: z.boolean(),
    toolCall: toolCallSchema.optional(),
    toolResult: toolResultSchema.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    goalCompleted: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<Message>;

/**
 * Zod schema for conversation status values.
 */
export const conversationStatusSchema = z.enum([
  'active',
  'archived',
  'deleted',
]) satisfies z.ZodType<ConversationStatus>;

/**
 * Raw conversation shape for storage systems that need direct access to fields.
 */
export const conversationShape = {
  schemaVersion: z.number().int().min(1),
  id: z.string(),
  title: z.string().optional(),
  status: conversationStatusSchema,
  metadata: z.record(z.string(), jsonValueSchema),
  ids: z.array(z.string()),
  messages: z.record(z.string(), messageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

/**
 * Zod schema for serialized conversations.
 */
export const conversationSchema = z
  .object(conversationShape)
  .strict() satisfies z.ZodType<Conversation>;
