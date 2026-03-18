import type { MultiModalContent } from '../multi-modal';
import type { ChatMessage, ConversationHistory as Conversation } from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { assertConversationSafe } from './validation';

/**
 * Converts conversation messages to the external chat message format.
 * Maps internal roles to standard user/assistant/system roles.
 * Hidden messages are excluded from the output.
 */
export function toChatMessages(conversation: Conversation): ChatMessage[] {
  assertConversationSafe(conversation);
  const roleMap: Record<string, 'user' | 'assistant' | 'system'> = {
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
    const externalRole = roleMap[message.role] as 'user' | 'assistant' | 'system';
    result.push({
      role: externalRole,
      content: message.content as string | MultiModalContent[],
    });
  }
  return result;
}
