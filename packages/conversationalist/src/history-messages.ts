import type { ConversationChangeContext } from './history-events';
import type { ConversationHistory } from './types';

export function diffConversationMessages(
  previousConversation: ConversationHistory,
  nextConversation: ConversationHistory,
): { appended: string[]; updated: string[]; removed: string[] } {
  const previousIds = new Set(previousConversation.ids);
  const nextIds = new Set(nextConversation.ids);
  const appended = nextConversation.ids.filter((id) => !previousIds.has(id));
  const removed = previousConversation.ids.filter((id) => !nextIds.has(id));
  const updated: string[] = [];

  for (const id of nextConversation.ids) {
    if (!previousIds.has(id)) continue;
    const previousMessage = previousConversation.messages[id];
    const nextMessage = nextConversation.messages[id];
    if (!previousMessage || !nextMessage) continue;
    if (JSON.stringify(previousMessage) !== JSON.stringify(nextMessage)) updated.push(id);
  }

  return { appended, updated, removed };
}

export function collectToolCallIds(
  conversation: ConversationHistory,
  messageIds?: readonly string[],
): string[] | undefined {
  if (!messageIds || messageIds.length === 0) return undefined;

  const ids = new Set<string>();
  for (const messageId of messageIds) {
    const message = conversation.messages[messageId];
    if (!message) continue;
    if (message.toolCall?.id) ids.add(message.toolCall.id);
    if (message.toolResult?.callId) ids.add(message.toolResult.callId);
  }

  return ids.size > 0 ? [...ids] : undefined;
}

export function createConversationChangeContext(
  previousConversation: ConversationHistory,
  nextConversation: ConversationHistory,
  action: 'messages.appended' | 'messages.updated' | 'messages.removed',
): ConversationChangeContext {
  const diff = diffConversationMessages(previousConversation, nextConversation);
  const messageIds =
    action === 'messages.appended'
      ? diff.appended
      : action === 'messages.updated'
        ? diff.updated
        : diff.removed;
  const toolCallIds = collectToolCallIds(
    action === 'messages.removed' ? previousConversation : nextConversation,
    messageIds,
  );
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    ...(toolCallIds ? { toolCallIds } : {}),
  };
}
