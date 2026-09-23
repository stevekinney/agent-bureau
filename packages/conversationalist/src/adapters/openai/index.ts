import type { ConversationHistory as Conversation } from '../../types';
import { appendOpenAIMessages, fromOpenAIMessages } from './inbound';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from './outbound';
import type { OpenAIConversationExportOptions, OpenAIMessage } from './types';

export const openAIConversationAdapter = {
  export(
    conversation: Conversation,
    options: OpenAIConversationExportOptions = {},
  ): OpenAIMessage[] {
    return options.groupToolCalls === false
      ? toOpenAIMessages(conversation)
      : toOpenAIMessagesGrouped(conversation);
  },
  import(messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return fromOpenAIMessages(messages);
  },
  append(conversation: Conversation, messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return appendOpenAIMessages(conversation, messages);
  },
} as const;
