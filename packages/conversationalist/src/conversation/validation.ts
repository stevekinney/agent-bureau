import { createValidationError } from '../errors';
import { conversationSchema } from '../schemas';
import type { ConversationHistory } from '../types';
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

export function ensureConversationSafe(
  conversation: ConversationHistory,
): ConversationHistory {
  assertConversationSafe(conversation);
  return conversation;
}
