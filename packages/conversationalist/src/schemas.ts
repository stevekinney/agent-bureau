import { z } from 'zod';

import type { MultiModalContent } from './multi-modal';
import type {
  ConversationHistory as Conversation,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToolAction,
  ToolCall,
  ToolCallInput,
  ToolError,
  ToolErrorCategory,
  ToolResult,
} from './types';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

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

const multiModalContentUnion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    citations: jsonValueSchema.optional(),
  }),
  z.object({
    type: z.literal('image'),
    url: z.string().url(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.object({
    type: z.literal('redacted_thinking'),
    data: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: jsonValueSchema,
  }),
  z.object({
    type: z.literal('server_tool_use'),
    id: z.string(),
    name: z.string(),
    input: jsonValueSchema,
  }),
  z.object({
    type: z.literal('web_search_tool_result'),
    tool_use_id: z.string(),
    content: jsonValueSchema,
  }),
  z.object({
    type: z.enum([
      'code_execution_tool_result',
      'bash_code_execution_tool_result',
      'text_editor_code_execution_tool_result',
    ]),
    tool_use_id: z.string(),
    content: jsonValueSchema,
  }),
]);

/**
 * Zod schema for multi-modal content parts (text, image, thinking,
 * redacted_thinking, tool_use, server_tool_use, web_search_tool_result, and
 * code-execution result blocks).
 *
 * The per-variant object schemas already guarantee every required protocol field
 * (data, ids, names) is present — no `?? ''` defaulting after the fact. The only
 * post-parse work is dropping absent optional fields (image mimeType/text, text
 * citations) rather than carrying `key: undefined`, so the output matches
 * {@link MultiModalContent} under `exactOptionalPropertyTypes`.
 */
export const multiModalContentSchema = multiModalContentUnion.transform(
  (value): MultiModalContent => {
    // Drop absent optional fields rather than carrying `key: undefined`, so the
    // output matches the interfaces under `exactOptionalPropertyTypes`.
    if (value.type === 'image') {
      return {
        type: 'image',
        url: value.url,
        ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
        ...(value.text !== undefined ? { text: value.text } : {}),
      };
    }
    if (value.type === 'text') {
      return {
        type: 'text',
        text: value.text,
        ...(value.citations !== undefined ? { citations: value.citations } : {}),
      };
    }
    return value;
  },
) satisfies z.ZodType<MultiModalContent>;

/**
 * Zod schema for valid message roles.
 */
export const messageRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'developer',
  'tool-call',
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

export const toolCallInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    arguments: jsonValueSchema.optional(),
  })
  .strict() satisfies z.ZodType<ToolCallInput>;

export const toolErrorCategorySchema = z.enum([
  'validation',
  'permission',
  'not_found',
  'conflict',
  'transient',
  'timeout',
  'cancelled',
  'internal',
]) satisfies z.ZodType<ToolErrorCategory>;

export const toolErrorSchema = z
  .object({
    code: z.string(),
    category: toolErrorCategorySchema,
    retryable: z.boolean(),
    message: z.string(),
    details: jsonValueSchema.optional(),
  })
  .strict() satisfies z.ZodType<ToolError>;

export const toolActionSchema = z
  .object({
    type: z.enum(['approval', 'input']),
    message: z.string().optional(),
    schema: jsonValueSchema.optional(),
  })
  .strict() satisfies z.ZodType<ToolAction>;

/**
 * Zod schema for tool result metadata.
 */
export const toolResultSchema = z
  .object({
    callId: z.string(),
    outcome: z.enum(['success', 'error', 'action_required']),
    content: jsonValueSchema,
    error: toolErrorSchema.optional(),
    action: toolActionSchema.optional(),
    inputDigest: z.string().optional(),
    outputDigest: z.string().optional(),
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
