import type { ConversationHistory, Message, MessagePlugin, TokenEstimator } from './types';
import { messageParts } from './utilities';

export interface SessionInfo {
  id: string;
  title?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * Extracts a lightweight SessionInfo summary from a ConversationHistory.
 */
export function toSessionInfo(conversation: ConversationHistory): SessionInfo {
  return {
    id: conversation.id,
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
    tags: (conversation.metadata['_tags'] as string[] | undefined) ?? [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.ids.length,
  };
}

/**
 * Environment functions for conversation operations.
 * Allows dependency injection for testing and custom ID generation.
 */
export interface ConversationEnvironment {
  now: () => string;
  randomId: () => string;
  estimateTokens: TokenEstimator;
  plugins: MessagePlugin[];
  /** Maximum depth of the undo/redo history tree. When exceeded, the oldest ancestor is pruned. */
  maxHistoryDepth?: number;
}

/**
 * Approximate serialized character length of a single content part. Text and
 * image-alt count as their text; thinking/tool/result blocks count by the size
 * of their payload (reasoning text, encrypted data, tool input/result JSON) so a
 * message made mostly of structural blocks is NOT estimated as near-zero tokens
 * and can still be truncated. This is a rough size proxy, not an exact tokenizer.
 */
function partCharLength(part: ReturnType<typeof messageParts>[number]): number {
  switch (part.type) {
    case 'text':
      return (
        part.text.length +
        (part.citations !== undefined ? JSON.stringify(part.citations).length : 0)
      );
    case 'image':
      return (part.text ?? '').length + (part.url?.length ?? 0);
    case 'thinking':
      return part.thinking.length + part.signature.length;
    case 'redacted_thinking':
      return part.data.length;
    case 'server_tool_use':
      return part.name.length + JSON.stringify(part.input).length;
    case 'web_search_tool_result':
      return JSON.stringify(part.content).length;
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'web_fetch_tool_result':
      return JSON.stringify(part.content).length;
    case 'container_upload':
      return part.file_id.length;
  }
}

/**
 * Simple character-based token estimator.
 * Approximates ~4 characters per token (rough average for English text). Counts
 * ALL content parts — including thinking and tool/result blocks — so structural
 * payloads are not under-counted toward the context budget.
 */
export function simpleTokenEstimator(message: Message): number {
  if (typeof message.content === 'string') {
    return Math.ceil(message.content.length / 4);
  }
  const total = messageParts(message).reduce((sum, part) => sum + partCharLength(part), 0);
  return Math.ceil(total / 4);
}

/**
 * Default environment using Date.toISOString(), crypto.randomUUID(), and simple token estimation.
 */
export const defaultConversationEnvironment: ConversationEnvironment = {
  now: () => new Date().toISOString(),
  randomId: () => crypto.randomUUID(),
  estimateTokens: simpleTokenEstimator,
  plugins: [],
};

/**
 * Merges a partial environment with defaults.
 * Returns a complete environment with all required functions.
 */
export function resolveConversationEnvironment(
  environment?: Partial<ConversationEnvironment>,
): ConversationEnvironment {
  return {
    now: environment?.now ?? defaultConversationEnvironment.now,
    randomId: environment?.randomId ?? defaultConversationEnvironment.randomId,
    estimateTokens: environment?.estimateTokens ?? defaultConversationEnvironment.estimateTokens,
    plugins: [...(environment?.plugins ?? defaultConversationEnvironment.plugins)],
    ...(environment?.maxHistoryDepth !== undefined
      ? { maxHistoryDepth: environment.maxHistoryDepth }
      : {}),
  };
}

/**
 * Type guard to distinguish environment objects from message inputs.
 * Returns true if the value has environment functions but no role property.
 */
export function isConversationEnvironmentParameter(
  value: unknown,
): value is Partial<ConversationEnvironment> {
  if (!value || typeof value !== 'object' || value === null) return false;
  if ('role' in (value as Record<string, unknown>)) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['now'] === 'function' ||
    typeof candidate['randomId'] === 'function' ||
    typeof candidate['estimateTokens'] === 'function' ||
    (Array.isArray(candidate['plugins']) && candidate['plugins'].length > 0)
  );
}

/**
 * Binds a partial environment to a function that accepts an environment as its last argument.
 */
export function withEnvironment<T extends unknown[], R>(
  environment: Partial<ConversationEnvironment>,
  fn: (...args: [...T, Partial<ConversationEnvironment>?]) => R,
): (...args: T) => R {
  return (...args: T) => fn(...args, environment);
}
