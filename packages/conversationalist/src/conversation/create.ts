import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import type {
  ConversationHistory,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
} from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { buildMessageFromInput, toReadonly } from '../utilities';
import { ensureConversationSafe, ensureMessageSafe } from './validation';

/**
 * Options for {@link buildMessage}.
 */
export interface BuildMessageOptions {
  /** Position to stamp on the message. Defaults to 0. */
  position?: number;
}

/**
 * Creates a new empty conversation with the specified options.
 * Returns an immutable conversation object with timestamps set to the current time.
 */
export function createConversationHistory(
  options?: {
    id?: string;
    title?: string;
    status?: ConversationStatus;
    metadata?: Record<string, JSONValue>;
  },
  environment?: Partial<ConversationEnvironment>,
): ConversationHistory {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();
  const conv: ConversationHistory = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: options?.id ?? resolvedEnvironment.randomId(),
    title: options?.title,
    status: options?.status ?? 'active',
    metadata: { ...(options?.metadata ?? {}) },
    ids: [],
    messages: {},
    createdAt: now,
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(conv));
}

/**
 * Mints a standalone, schema-valid Message from a MessageInput without
 * requiring a ConversationHistory. Useful for simulating an inbound message
 * that isn't yet part of a conversation (e.g. an adapter push handler), or
 * for constructing a message to hand to `prependMessages`/`appendMessages`
 * elsewhere.
 *
 * The returned message defaults to `position: 0`; pass `options.position` if
 * it needs to reflect where the message will ultimately live.
 *
 * Also accepts a bound `ConversationEnvironment` landing in the `options`
 * position, matching every other builder in this module —
 * `withEnvironment(env, buildMessage)` calls `fn(...args, env)`, so a
 * no-options bound call lands the environment there instead of `environment`.
 */
export function buildMessage(
  input: MessageInput,
  options?: BuildMessageOptions,
  environment?: Partial<ConversationEnvironment>,
): Message {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const processedInput = resolvedEnvironment.plugins.reduce((acc, plugin) => plugin(acc), input);
  const message = buildMessageFromInput(
    processedInput,
    resolvedOptions?.position ?? 0,
    resolvedEnvironment.now(),
    resolvedEnvironment,
  );
  return ensureMessageSafe(message);
}

/**
 * Creates a new empty conversation without validating schema or integrity.
 */
export function createConversationHistoryUnsafe(
  options?: {
    id?: string;
    title?: string;
    status?: ConversationStatus;
    metadata?: Record<string, JSONValue>;
  },
  environment?: Partial<ConversationEnvironment>,
): ConversationHistory {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();
  const conv: ConversationHistory = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: options?.id ?? resolvedEnvironment.randomId(),
    title: options?.title,
    status: options?.status ?? 'active',
    metadata: { ...(options?.metadata ?? {}) },
    ids: [],
    messages: {},
    createdAt: now,
    updatedAt: now,
  };
  return toReadonly(conv);
}
