import type { ConversationHistory as Conversation } from '../../types';
import { appendGeminiMessages, fromGeminiMessages } from './inbound';
import { toGeminiMessages } from './outbound';
import type { GeminiConversation } from './types';

export const geminiConversationAdapter = {
  export(conversation: Conversation): GeminiConversation {
    return toGeminiMessages(conversation);
  },
  import(payload: GeminiConversation): Conversation {
    return fromGeminiMessages(payload);
  },
  append(conversation: Conversation, payload: GeminiConversation): Conversation {
    return appendGeminiMessages(conversation, payload);
  },
} as const;
