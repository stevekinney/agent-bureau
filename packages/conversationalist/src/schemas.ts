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
          code: 'custom',
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
    url: z.url(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('document'),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('base64'),
        data: z.string().min(1),
      }),
      z.object({
        kind: z.literal('reference'),
        uri: z.string().min(1),
      }),
    ]),
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
      'web_fetch_tool_result',
    ]),
    tool_use_id: z.string(),
    content: jsonValueSchema,
  }),
  z.object({
    type: z.literal('container_upload'),
    file_id: z.string(),
  }),
]);

/**
 * Zod schema for multi-modal content parts (text, image, document, thinking,
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
  'unavailable',
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

const explicitTimezoneIsoDateTimeSchema = z.string().refine(isExplicitTimezoneIsoDateTime, {
  message: 'expected an ISO8601 date-time with explicit timezone',
});

const toolApprovalOperationBaseSchema = z.object({
  filesTouched: z.array(z.string()).exactOptional(),
  argsPreview: jsonValueSchema.optional(),
});

const toolApprovalOperationSchema = z.discriminatedUnion('kind', [
  toolApprovalOperationBaseSchema
    .extend({
      kind: z.literal('command'),
      command: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file-write'),
      filesTouched: z.array(z.string()).min(1),
      argsPreview: jsonValueSchema.optional(),
    })
    .strict(),
  toolApprovalOperationBaseSchema
    .extend({
      kind: z.literal('patch'),
      diff: z.string().min(1),
    })
    .strict(),
  toolApprovalOperationBaseSchema
    .extend({
      kind: z.literal('other'),
    })
    .strict(),
]);

export const toolActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('input'),
      message: z.string().optional(),
      schema: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval'),
      message: z.string().optional(),
      risk: z.enum(['low', 'medium', 'high']),
      operation: toolApprovalOperationSchema,
      sandbox: z
        .object({
          provider: z.string().min(1),
          name: z.string().min(1),
          workingDir: z.string().min(1),
        })
        .strict()
        .optional(),
      env: z.array(z.string()).optional(),
      snapshotId: z.string().min(1).optional(),
      expiresAt: explicitTimezoneIsoDateTimeSchema.optional(),
      editableArgs: z.boolean().optional(),
      policyVersion: z.string().min(1),
      idempotencyKey: z.string().min(1),
    })
    .strict(),
]) satisfies z.ZodType<ToolAction>;

function isExplicitTimezoneIsoDateTime(value: string): boolean {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?<fraction>\.\d+)?(?<timezone>Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match?.groups) return false;
  const year = Number(match.groups['year']);
  const month = Number(match.groups['month']);
  const day = Number(match.groups['day']);
  const hour = Number(match.groups['hour']);
  const minute = Number(match.groups['minute']);
  const second = Number(match.groups['second']);
  const timezone = match.groups['timezone']!;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (timezone !== 'Z') {
    const timezoneHour = Number(timezone.slice(1, 3));
    const timezoneMinute = Number(timezone.slice(4, 6));
    if (timezoneHour > 23 || timezoneMinute > 59) return false;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    (timezone !== 'Z' || calendar.getUTCHours() === hour) &&
    (timezone !== 'Z' || calendar.getUTCMinutes() === minute) &&
    (timezone !== 'Z' || calendar.getUTCSeconds() === second)
  );
}

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
  cacheCreationTokens: z.number().int().min(0).optional(),
  cacheReadTokens: z.number().int().min(0).optional(),
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
    cacheBoundary: z.boolean().optional(),
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
    cacheBoundary: z.boolean().optional(),
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
