import {
  type ConversationEnvironment,
  resolveConversationEnvironment,
} from '../environment';
import type { ConversationHistory, ConversationStatus, JSONValue } from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';
import { ensureConversationSafe } from './validation';

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
