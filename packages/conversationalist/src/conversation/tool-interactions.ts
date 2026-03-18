import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  TokenUsage,
  ToolCall,
  ToolCallInput,
  ToolResult,
} from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { pairToolCallsWithResults } from '../utilities/tool-calls';
import { appendMessages } from './append';

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

type AppendableToolResult = ToolResult & {
  result?: unknown;
  stream?: AsyncIterable<unknown> | undefined;
};

export interface ToolInteraction {
  call: ToolCall;
  result?: ToolResult | undefined;
}

/**
 * Appends a tool-call message with the provided tool call metadata.
 */
export function appendToolCall(
  conversation: Conversation,
  toolCall: ToolCallInput,
  options?: AppendToolCallOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;

  return appendMessages(
    conversation,
    createToolCallMessageInput(
      normalizeToolCallInput(toolCall, resolvedEnvironment),
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
  toolCalls: ReadonlyArray<ToolCallInput>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  if (toolCalls.length === 0) {
    return conversation;
  }

  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const messageInputs = toolCalls.map((toolCall) =>
    createToolCallMessageInput(
      normalizeToolCallInput(toolCall, resolvedEnvironment),
      undefined,
    ),
  );

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
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;
  const normalizedToolResult = normalizeToolResultSync(toolResult);

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

  const messageInputs = toolResults.map((toolResult) =>
    createToolResultMessageInput(normalizeToolResultSync(toolResult), undefined),
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
  const resolvedOptions = isConversationEnvironmentParameter(options)
    ? undefined
    : options;
  const normalizedToolResult = await normalizeToolResultAsync(toolResult);

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

  const normalizedToolResults = await Promise.all(
    toolResults.map((toolResult) => normalizeToolResultAsync(toolResult)),
  );

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

function normalizeToolCallInput(
  toolCall: ToolCallInput,
  environment: ConversationEnvironment,
): ToolCall {
  return {
    id: toolCall.id ?? environment.randomId(),
    name: toolCall.name,
    arguments: toolCall.arguments ?? {},
  };
}

function normalizeToolResultSync(toolResult: AppendableToolResult): ToolResult {
  if (hasStreamingPayload(toolResult)) {
    throw new Error(
      'appendToolResult does not support streaming tool results. Use appendToolResultAsync or appendToolResultsAsync.',
    );
  }

  return stripRuntimeToolResultFields(toolResult, toolResult.content);
}

async function normalizeToolResultAsync(
  toolResult: AppendableToolResult,
): Promise<ToolResult> {
  const streamingPayload = getStreamingPayload(toolResult);
  if (!streamingPayload) {
    return stripRuntimeToolResultFields(toolResult, toolResult.content);
  }

  const chunks = await collectAsyncIterable(streamingPayload);
  return stripRuntimeToolResultFields(toolResult, chunks as JSONValue);
}

function stripRuntimeToolResultFields(
  toolResult: AppendableToolResult,
  content: JSONValue,
): ToolResult {
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content,
    ...(toolResult.error ? { error: toolResult.error } : {}),
    ...(toolResult.action ? { action: toolResult.action } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

function hasStreamingPayload(toolResult: AppendableToolResult): boolean {
  return getStreamingPayload(toolResult) !== undefined;
}

function getStreamingPayload(
  toolResult: AppendableToolResult,
): AsyncIterable<unknown> | undefined {
  if (toolResult.stream) {
    return toolResult.stream;
  }

  if (isAsyncIterable(toolResult.result)) {
    return toolResult.result;
  }

  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return Symbol.asyncIterator in value;
}

async function collectAsyncIterable(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}
