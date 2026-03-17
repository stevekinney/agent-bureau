import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import type {
  Conversation,
  JSONValue,
  MessageInput,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { pairToolCallsWithResults } from '../utilities/tool-calls';
import { appendMessages } from './append';

export interface AppendToolUseOptions {
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

export interface ToolUseInput {
  toolId: string;
  callId?: string;
  args: JSONValue;
}

export interface ToolResultInput {
  callId: string;
  outcome: 'success' | 'error';
  result: JSONValue;
}

export interface ToolInteraction {
  call: ToolCall;
  result?: ToolResult | undefined;
}

/**
 * Appends a tool-use message with the provided tool call metadata.
 */
export function appendToolUse(
  conversation: Conversation,
  toolCall: ToolUseInput,
  options?: AppendToolUseOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolved = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;
  const callId = toolCall.callId ?? resolved.randomId();
  const toolCallMeta: ToolCall = {
    id: callId,
    name: toolCall.toolId,
    arguments: toolCall.args,
  };

  return appendMessages(
    conversation,
    {
      role: 'tool-use',
      content: resolvedOptions?.content ?? '',
      metadata: resolvedOptions?.metadata,
      hidden: resolvedOptions?.hidden,
      toolCall: toolCallMeta,
      tokenUsage: resolvedOptions?.tokenUsage,
    },
    resolved,
  );
}

/**
 * Appends a tool-result message with the provided tool result metadata.
 */
export function appendToolResult(
  conversation: Conversation,
  toolResult: ToolResultInput,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;
  const toolResultMeta: ToolResult = {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content: toolResult.result,
  };

  return appendMessages(
    conversation,
    {
      role: 'tool-result',
      content: resolvedOptions?.content ?? '',
      metadata: resolvedOptions?.metadata,
      hidden: resolvedOptions?.hidden,
      toolResult: toolResultMeta,
      tokenUsage: resolvedOptions?.tokenUsage,
    },
    isConversationEnvironmentParameter(options) ? options : environment,
  );
}

/**
 * Returns tool calls that have no corresponding tool result yet.
 */
export function getPendingToolCalls(conversation: Conversation): ToolCall[] {
  const ordered = getOrderedMessages(conversation);
  const completed = new Set<string>();

  for (const message of ordered) {
    if (message.role === 'tool-result' && message.toolResult) {
      completed.add(message.toolResult.callId);
    }
  }

  const pending: ToolCall[] = [];
  for (const message of ordered) {
    if (message.role === 'tool-use' && message.toolCall) {
      if (!completed.has(message.toolCall.id)) {
        pending.push(message.toolCall);
      }
    }
  }

  return pending;
}

/**
 * Returns tool calls paired with their optional results in message order.
 */
export function getToolInteractions(conversation: Conversation): ToolInteraction[] {
  return pairToolCallsWithResults(getOrderedMessages(conversation));
}
