import { createIntegrityError } from '../errors';
import type { Conversation } from '../types';

export type IntegrityIssueCode =
  | 'integrity:missing-message'
  | 'integrity:unlisted-message'
  | 'integrity:duplicate-message-id'
  | 'integrity:orphan-tool-result'
  | 'integrity:tool-result-before-call'
  | 'integrity:duplicate-tool-call';

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  message: string;
  data?: Record<string, unknown> | undefined;
}

/**
 * Validates conversation invariants and returns a list of issues.
 */
export function validateConversationIntegrity(
  conversation: Conversation,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const seenIds = new Set<string>();

  conversation.ids.forEach((id, index) => {
    if (seenIds.has(id)) {
      issues.push({
        code: 'integrity:duplicate-message-id',
        message: `duplicate message id in ids: ${id}`,
        data: { id, position: index },
      });
    } else {
      seenIds.add(id);
    }

    if (!conversation.messages[id]) {
      issues.push({
        code: 'integrity:missing-message',
        message: `missing message for id ${id}`,
        data: { id, position: index },
      });
    }
  });

  for (const id of Object.keys(conversation.messages)) {
    if (!seenIds.has(id)) {
      issues.push({
        code: 'integrity:unlisted-message',
        message: `message ${id} is not listed in ids`,
        data: { id },
      });
    }
  }

  const toolUses = new Map<string, { position: number; messageId: string }>();

  conversation.ids.forEach((id, index) => {
    const message = conversation.messages[id];
    if (!message) return;

    if (message.role === 'tool-use' && message.toolCall) {
      if (toolUses.has(message.toolCall.id)) {
        issues.push({
          code: 'integrity:duplicate-tool-call',
          message: `duplicate toolCall.id ${message.toolCall.id}`,
          data: { toolCallId: message.toolCall.id, messageId: message.id },
        });
      } else {
        toolUses.set(message.toolCall.id, { position: index, messageId: message.id });
      }
    }
  });

  conversation.ids.forEach((id, index) => {
    const message = conversation.messages[id];
    if (!message) return;

    if (message.role === 'tool-result' && message.toolResult) {
      const toolUse = toolUses.get(message.toolResult.callId);
      if (!toolUse) {
        issues.push({
          code: 'integrity:orphan-tool-result',
          message: `tool-result references missing tool-use ${message.toolResult.callId}`,
          data: { callId: message.toolResult.callId, messageId: message.id },
        });
      } else if (toolUse.position >= index) {
        issues.push({
          code: 'integrity:tool-result-before-call',
          message: `tool-result ${message.toolResult.callId} occurs before tool-use`,
          data: {
            callId: message.toolResult.callId,
            messageId: message.id,
            toolUseMessageId: toolUse.messageId,
          },
        });
      }
    }
  });

  return issues;
}

/**
 * Throws an integrity error if the conversation fails validation.
 */
export function assertConversationIntegrity(conversation: Conversation): void {
  const issues = validateConversationIntegrity(conversation);
  if (issues.length === 0) return;

  throw createIntegrityError('conversation integrity check failed', { issues });
}
