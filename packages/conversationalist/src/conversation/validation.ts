import { createValidationError } from '../errors';
import { conversationSchema, messageSchema } from '../schemas';
import type { ConversationHistory, Message } from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import { assertConversationHistoryIntegrity } from './integrity';

function detachMutableValue<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return structuredClone(value);
  const detached = { ...value };
  for (const [key, nested] of Object.entries(value)) {
    Object.defineProperty(detached, key, {
      value: detachMutableValue(nested),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return detached;
}

/**
 * Ensures a conversation conforms to the schema (JSON-safe) and integrity rules.
 * Internal helper for public API enforcement points.
 */
export function assertConversationSafe(conversation: ConversationHistory): void {
  const parsed = conversationSchema.safeParse(conversation);
  if (!parsed.success) {
    throw createValidationError('conversation failed schema validation', {
      issues: parsed.error.issues,
    });
  }

  assertConversationHistoryIntegrity(conversation);
}

export function ensureConversationSafe(conversation: ConversationHistory): ConversationHistory {
  assertConversationSafe(conversation);
  return deepFreeze(detachMutableValue(conversation));
}

/**
 * Ensures a standalone message conforms to the schema (JSON-safe).
 * Internal helper for public API enforcement points.
 */
export function assertMessageSafe(message: Message): void {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) {
    throw createValidationError('message failed schema validation', {
      issues: parsed.error.issues,
    });
  }
}

export function ensureMessageSafe(message: Message): Message {
  assertMessageSafe(message);
  return deepFreeze(detachMutableValue(message));
}
