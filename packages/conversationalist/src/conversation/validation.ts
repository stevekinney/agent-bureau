import { createValidationError } from '../errors';
import { conversationSchema, messageSchema } from '../schemas';
import type { ConversationHistory, Message } from '../types';
import { assertConversationHistoryIntegrity } from './integrity';

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
  return conversation;
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
  return message;
}
