import type { ConversationHistory as Conversation } from '../../types';
import { appendAnthropicMessages, fromAnthropicMessages } from './inbound';
import { toAnthropicMessages } from './outbound';
import type { AnthropicConversation } from './types';

export const anthropicConversationAdapter = {
  export(conversation: Conversation): AnthropicConversation {
    return toAnthropicMessages(conversation);
  },
  import(payload: AnthropicConversation): Conversation {
    return fromAnthropicMessages(payload);
  },
  append(conversation: Conversation, payload: AnthropicConversation): Conversation {
    return appendAnthropicMessages(conversation, payload);
  },
} as const;
