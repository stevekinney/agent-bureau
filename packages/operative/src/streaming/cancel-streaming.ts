import type { Conversation } from 'conversationalist';

/**
 * Cancels a streaming message if it is still the active streaming message on
 * the conversation. Safe to call when the message may have already been
 * finalized or cancelled.
 */
export function cancelStreamingIfActive(conversation: Conversation, messageId: string): void {
  const message = conversation.getStreamingMessage();
  if (message && message.id === messageId) {
    conversation.cancelStreamingMessage(messageId);
  }
}
