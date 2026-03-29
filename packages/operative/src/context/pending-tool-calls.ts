import type { Message } from 'conversationalist';

/**
 * Returns the set of tool-call IDs that have no corresponding result.
 * Used by both the context assembler and compaction strategies to identify
 * tool interactions that must be preserved.
 */
export function getPendingToolCallIds(messages: ReadonlyArray<Message>): Set<string> {
  const completedIds = new Set<string>();
  const allCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'tool-call' && message.toolCall) {
      allCallIds.add(message.toolCall.id);
    }
    if (message.role === 'tool-result' && message.toolResult) {
      completedIds.add(message.toolResult.callId);
    }
  }

  const pending = new Set<string>();
  for (const id of allCallIds) {
    if (!completedIds.has(id)) {
      pending.add(id);
    }
  }
  return pending;
}
