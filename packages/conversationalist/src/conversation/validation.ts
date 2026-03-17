import { createValidationError } from '../errors';
import { conversationSchema } from '../schemas';
import type { Conversation } from '../types';
import { assertConversationIntegrity } from './integrity';

/**
 * Ensures a conversation conforms to the schema (JSON-safe) and integrity rules.
 * Internal helper for public API enforcement points.
 */
export function assertConversationSafe(conversation: Conversation): void {
  const parsed = conversationSchema.safeParse(conversation);
  if (!parsed.success) {
    throw createValidationError('conversation failed schema validation', {
      issues: parsed.error.issues,
    });
  }

  assertConversationIntegrity(conversation);
}

export function ensureConversationSafe(conversation: Conversation): Conversation {
  assertConversationSafe(conversation);
  return conversation;
}
