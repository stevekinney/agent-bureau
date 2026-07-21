import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from 'interoperability';

import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import {
  createIntegrityError,
  createInvalidInputError,
  createToolResultNotFoundError,
} from '../errors';
import type {
  AppendableToolCallInput,
  AppendableToolResult,
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  MessageInput,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../types';
import { createMessage, toReadonly } from '../utilities';
import { getOrderedMessages } from '../utilities/message-store';
import { pairToolCallsWithResults } from '../utilities/tool-calls';
import { appendMessages } from './append';
import { ensureConversationSafe } from './validation';
export type { MaterializeToolCallOptions } from 'interoperability';
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from 'interoperability';

export interface AppendToolCallOptions {
  content?: MessageInput['content'];
  metadata?: Record<string, JSONValue>;
  hidden?: boolean;
  tokenUsage?: TokenUsage;
}

export interface AppendToolResultOptions {
  content?: MessageInput['content'];
  metadata?: Record<string, JSONValue>;
  hidden?: boolean;
  tokenUsage?: TokenUsage;
}

export interface ToolInteraction {
  call: ToolCall;
  result?: ToolResult | undefined;
}

/**
 * Appends a tool-call message with the provided tool call metadata.
 */
export function appendToolCall(
  conversation: Conversation,
  toolCall: AppendableToolCallInput,
  options?: AppendToolCallOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;

  return appendMessages(
    conversation,
    createToolCallMessageInput(
      materializeToolCall(toolCall, {
        generateId: resolvedEnvironment.randomId,
      }),
      resolvedOptions,
    ),
    resolvedEnvironment,
  );
}

/**
 * Appends multiple tool-call messages in order.
 */
export function appendToolCalls(
  conversation: Conversation,
  toolCalls: ReadonlyArray<AppendableToolCallInput>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  if (toolCalls.length === 0) {
    return conversation;
  }

  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const messageInputs = materializeToolCalls(toolCalls, {
    generateId: resolvedEnvironment.randomId,
  }).map((toolCall) => createToolCallMessageInput(toolCall, undefined));

  return appendMessages(conversation, ...messageInputs, resolvedEnvironment);
}

/**
 * Appends a tool-result message with the provided tool result metadata.
 */
export function appendToolResult(
  conversation: Conversation,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const normalizedToolResult = materializeToolResult(toolResult);

  return appendMessages(
    conversation,
    createToolResultMessageInput(normalizedToolResult, resolvedOptions),
    isConversationEnvironmentParameter(options) ? options : environment,
  );
}

/**
 * Appends multiple tool-result messages in order.
 */
export function appendToolResults(
  conversation: Conversation,
  toolResults: ReadonlyArray<AppendableToolResult>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  if (toolResults.length === 0) {
    return conversation;
  }

  const messageInputs = materializeToolResults(toolResults).map((toolResult) =>
    createToolResultMessageInput(toolResult, undefined),
  );

  return appendMessages(conversation, ...messageInputs, environment);
}

/**
 * Appends a tool-result message, collecting streaming payloads before the history changes.
 */
export async function appendToolResultAsync(
  conversation: Conversation,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<Conversation> {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const normalizedToolResult = await materializeToolResultAsync(toolResult);

  return appendMessages(
    conversation,
    createToolResultMessageInput(normalizedToolResult, resolvedOptions),
    isConversationEnvironmentParameter(options) ? options : environment,
  );
}

/**
 * Appends multiple tool-result messages, collecting streaming payloads before the history changes.
 */
export async function appendToolResultsAsync(
  conversation: Conversation,
  toolResults: ReadonlyArray<AppendableToolResult>,
  environment?: Partial<ConversationEnvironment>,
): Promise<Conversation> {
  if (toolResults.length === 0) {
    return conversation;
  }

  const normalizedToolResults = await materializeToolResultsAsync(toolResults);

  const messageInputs = normalizedToolResults.map((toolResult) =>
    createToolResultMessageInput(toolResult, undefined),
  );

  return appendMessages(conversation, ...messageInputs, environment);
}

/**
 * Replaces the tool-result message for `callId` with a new result, in
 * place — producing exactly one tool-result message for that call
 * afterwards. This is the primitive a host needs to turn a pending
 * `action_required` result (appended before a run parks on approval) into
 * the resolved result from `toolbox.resumeApproval()`, without ending up
 * with two tool-result messages for the same call — a malformed
 * conversation most providers reject or mishandle on the next turn.
 *
 * Locates the message purely by `toolResult.callId`, by scanning
 * `conversation.messages` — never by position or by an undo/redo node
 * graph — so it behaves identically on a freshly-built `Conversation` and
 * one rehydrated from a persisted `ConversationHistory` (the exact case a
 * stateless host hits on every resume, since it reconstructs the
 * conversation from stored JSON each request).
 *
 * **Identity**: the replacement message keeps the original message's `id`,
 * `createdAt`, and `position` — it is the same logical result being
 * resolved, not a new message appended after it. This mirrors
 * {@link redactMessageAtPosition}'s in-place replacement and means callers
 * holding a reference to the pending result's message id keep a valid
 * reference afterwards.
 *
 * `content`/`metadata`/`hidden`/`tokenUsage` default to the original
 * message's values and can be overridden via `options`, same as
 * {@link appendToolResult}.
 *
 * Throws `error:not-found` if no tool-result message exists for `callId`,
 * `error:integrity` if more than one does (an already-malformed
 * conversation state — replacing one of several would silently guess which
 * one the caller meant), and `error:invalid-input` if `toolResult.callId`
 * disagrees with `callId` (replacing the wrong message silently would be
 * worse than refusing).
 */
export function resolveToolResult(
  conversation: Conversation,
  callId: string,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const resolvedEnvironmentInput = isConversationEnvironmentParameter(options)
    ? options
    : environment;

  const matches = getOrderedMessages(conversation).filter(
    (message): message is Message & { toolResult: ToolResult } =>
      message.role === 'tool-result' &&
      message.toolResult !== undefined &&
      message.toolResult.callId === callId,
  );

  const original = matches[0];
  if (!original) {
    throw createToolResultNotFoundError(callId);
  }

  if (matches.length > 1) {
    throw createIntegrityError(`multiple tool-result messages found for callId: ${callId}`, {
      callId,
      messageIds: matches.map((message) => message.id),
    });
  }

  const normalizedToolResult = materializeToolResult(toolResult);
  if (normalizedToolResult.callId !== callId) {
    throw createInvalidInputError(
      `toolResult.callId (${normalizedToolResult.callId}) does not match callId (${callId})`,
      { callId, toolResultCallId: normalizedToolResult.callId },
    );
  }

  const resolvedEnvironment = resolveConversationEnvironment(resolvedEnvironmentInput);
  const now = resolvedEnvironment.now();

  const replaced = createMessage({
    id: original.id,
    role: original.role,
    content: resolvedOptions?.content ?? original.content,
    position: original.position,
    createdAt: original.createdAt,
    metadata: { ...(resolvedOptions?.metadata ?? original.metadata) },
    hidden: resolvedOptions?.hidden ?? original.hidden,
    toolResult: normalizedToolResult,
    tokenUsage: resolvedOptions?.tokenUsage ?? original.tokenUsage,
    cacheBoundary: original.cacheBoundary,
  });

  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [replaced.id]: replaced },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}

/**
 * Returns tool calls that have no corresponding tool result yet.
 */
export function getPendingToolCalls(conversation: Conversation): ToolCall[] {
  const orderedMessages = getOrderedMessages(conversation);
  const completedCallIdentifiers = new Set<string>();

  for (const message of orderedMessages) {
    if (message.role === 'tool-result' && message.toolResult) {
      completedCallIdentifiers.add(message.toolResult.callId);
    }
  }

  const pendingToolCalls: ToolCall[] = [];
  for (const message of orderedMessages) {
    if (message.role === 'tool-call' && message.toolCall) {
      if (!completedCallIdentifiers.has(message.toolCall.id)) {
        pendingToolCalls.push(message.toolCall);
      }
    }
  }

  return pendingToolCalls;
}

/**
 * Returns tool calls paired with their optional results in message order.
 */
export function getToolInteractions(conversation: Conversation): ToolInteraction[] {
  return pairToolCallsWithResults(getOrderedMessages(conversation));
}

function createToolCallMessageInput(
  toolCall: ToolCall,
  options?: AppendToolCallOptions,
): MessageInput {
  return {
    role: 'tool-call',
    content: options?.content ?? '',
    metadata: options?.metadata,
    hidden: options?.hidden,
    toolCall,
    tokenUsage: options?.tokenUsage,
  };
}

function createToolResultMessageInput(
  toolResult: ToolResult,
  options?: AppendToolResultOptions,
): MessageInput {
  return {
    role: 'tool-result',
    content: options?.content ?? '',
    metadata: options?.metadata,
    hidden: options?.hidden,
    toolResult,
    tokenUsage: options?.tokenUsage,
  };
}
