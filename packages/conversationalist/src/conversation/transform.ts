import { copyContent } from '../multi-modal';
import type { ChatMessage, ConversationHistory as Conversation, MessageRole } from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { assertConversationSafe } from './validation';

/**
 * Converts conversation messages to the external chat message format.
 * Maps internal roles to standard user/assistant/system roles.
 * Hidden messages are excluded from the output.
 */
export function toChatMessages(conversation: Conversation): ChatMessage[] {
  assertConversationSafe(conversation);
  const roleMap: Record<MessageRole, ChatMessage['role']> = {
    user: 'user',
    assistant: 'assistant',
    system: 'system',
    developer: 'system',
    'tool-call': 'assistant',
    'tool-result': 'user',
    snapshot: 'system',
  };

  const result: ChatMessage[] = [];
  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden) continue;
    result.push({
      role: roleMap[message.role],
      content: copyContent(message.content),
    });
  }
  return result;
}
