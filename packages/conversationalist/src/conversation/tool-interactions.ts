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
import type {
  AppendableToolCallInput,
  AppendableToolResult,
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { pairToolCallsWithResults } from '../utilities/tool-calls';
import { appendMessages } from './append';
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
 * Appends a tool-result message, collecting streaming payloads before persistence.
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
 * Appends multiple tool-result messages, collecting streaming payloads before persistence.
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
