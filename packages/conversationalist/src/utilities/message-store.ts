import type { Conversation, Message } from '../types';

export function getOrderedMessages(conversation: Conversation): Message[] {
  const ordered: Message[] = [];
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message) {
      ordered.push(message);
    }
  }
  return ordered;
}

export function toIdRecord<T extends { id: string }>(
  items: readonly T[],
): Record<string, T> {
  const record: Record<string, T> = {};
  for (const item of items) {
    record[item.id] = item;
  }
  return record;
}
