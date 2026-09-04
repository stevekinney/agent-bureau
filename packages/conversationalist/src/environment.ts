import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type {
  ConversationHistory,
  Message,
  MessageInput,
  MessagePlugin,
  MessagePluginIdentity,
  TokenEstimator,
} from './types';
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
 * The slice of {@link RuntimeServices} (lifecycle's AB-92/AB-252 seam)
 * conversationalist's environment reads through: identifiers and the clock.
 * A caller passes a full `RuntimeServices` instance here — the extra
 * members (`monotonic`, `timers`, `random`, `deferred`) are ignored, not
 * rejected, because `RuntimeServices` structurally satisfies this `Pick`.
 */
export type ConversationRuntime = Pick<RuntimeServices, 'clock' | 'identifiers'>;

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
  /**
   * AB-321: the identifier and clock seam a conversation mints ids and
   * timestamps through. Defaults to the real implementation
   * ({@link createDefaultRuntimeServices}). Explicit `now`/`randomId`
   * overrides still win when supplied directly, for backward
   * compatibility with environments that customize only one function.
   */
  runtime?: ConversationRuntime;
}

export function getMessagePluginIdentity(
  plugin: MessagePlugin,
  index: number,
): MessagePluginIdentity {
  return Object.freeze({
    id: plugin.id ?? plugin.name ?? `plugin-${index + 1}`,
    revision: plugin.revision ?? 1,
    authority: 'transcript-transform',
  });
}

export function defineMessagePlugin(
  identity: { id: string; revision: number },
  transform: (input: MessageInput) => MessageInput,
): MessagePlugin {
  if (
    identity.id.trim().length === 0 ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 1
  ) {
    throw new TypeError(
      'Message plugin identity requires a non-empty id and a positive integer revision',
    );
  }
  return Object.assign(transform, Object.freeze({ ...identity }));
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
    case 'document':
      return (
        part.name.length +
        part.mimeType.length +
        (part.source.kind === 'base64' ? part.source.data.length : part.source.uri.length)
      );
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
 * The real-globals `RuntimeServices` instance conversationalist falls back
 * to when neither an explicit `runtime` nor explicit `now`/`randomId`
 * overrides are supplied. A module-level singleton, matching the pattern
 * every other real-implementation default in this package already follows
 * (one shared instance, not a fresh one per resolution).
 */
const defaultConversationRuntime: ConversationRuntime = createDefaultRuntimeServices();

/**
 * Default environment reading through {@link defaultConversationRuntime}
 * (AB-321), the real implementation of the AB-92/AB-252 `RuntimeServices`
 * seam, plus simple token estimation.
 */
export const defaultConversationEnvironment: ConversationEnvironment = {
  now: () => defaultConversationRuntime.clock.nowISO(),
  randomId: () => defaultConversationRuntime.identifiers.next('conversation'),
  estimateTokens: simpleTokenEstimator,
  plugins: [],
  runtime: defaultConversationRuntime,
};

/**
 * Merges a partial environment with defaults.
 * Returns a complete environment with all required functions.
 *
 * Precedence for `now`/`randomId`: an explicit override on `environment`
 * wins outright; otherwise an explicit `environment.runtime` is read
 * through; otherwise the real-globals default runtime is read through.
 */
export function resolveConversationEnvironment(
  environment?: Partial<ConversationEnvironment>,
): ConversationEnvironment {
  const runtime = environment?.runtime;
  return {
    now:
      environment?.now ??
      (runtime ? () => runtime.clock.nowISO() : defaultConversationEnvironment.now),
    randomId:
      environment?.randomId ??
      (runtime
        ? () => runtime.identifiers.next('conversation')
        : defaultConversationEnvironment.randomId),
    estimateTokens: environment?.estimateTokens ?? defaultConversationEnvironment.estimateTokens,
    plugins: [...(environment?.plugins ?? defaultConversationEnvironment.plugins)],
    runtime: runtime ?? defaultConversationRuntime,
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
  const runtime = candidate['runtime'];
  const hasRuntime =
    !!runtime &&
    typeof runtime === 'object' &&
    typeof (runtime as Record<string, unknown>)['clock'] === 'object' &&
    typeof (runtime as Record<string, unknown>)['identifiers'] === 'object';
  return (
    typeof candidate['now'] === 'function' ||
    typeof candidate['randomId'] === 'function' ||
    typeof candidate['estimateTokens'] === 'function' ||
    (Array.isArray(candidate['plugins']) && candidate['plugins'].length > 0) ||
    typeof candidate['maxHistoryDepth'] === 'number' ||
    hasRuntime
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
