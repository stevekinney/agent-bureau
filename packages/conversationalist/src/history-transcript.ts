import { estimateConversationTokens } from './context';
import { getRecentMessages } from './context-recent';
import {
  getFirstSystemMessage,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getStatistics,
  getSystemMessages,
  hasSystemMessage,
  searchConversationMessages,
  toChatMessages,
} from './conversation/index';
import type { ConversationEnvironment } from './environment';
import type { ConversationHistory, Message } from './types';

export type TranscriptActions = {
  readonly getMessages: (options?: { includeHidden?: boolean }) => ReadonlyArray<Message>;
  readonly getMessageAtPosition: (position: number) => Message | undefined;
  readonly getMessageIds: () => string[];
  readonly getMessageById: (id: string) => Message | undefined;
  readonly get: (id: string) => Message | undefined;
  readonly searchMessages: (predicate: (message: Message) => boolean) => Message[];
  readonly getStatistics: () => ReturnType<typeof getStatistics>;
  readonly hasSystemMessage: () => boolean;
  readonly getFirstSystemMessage: () => Message | undefined;
  readonly getSystemMessages: () => ReadonlyArray<Message>;
  readonly toChatMessages: () => ReturnType<typeof toChatMessages>;
  readonly estimateTokens: (estimator?: (message: Message) => number) => number;
  readonly getRecentMessages: (
    count: number,
    options?: { includeHidden?: boolean; includeSystem?: boolean; preserveToolPairs?: boolean },
  ) => ReadonlyArray<Message>;
};

/** Creates the bound transcript actions for one conversation instance. */
export function createTranscriptActions(
  current: () => ConversationHistory,
  environment: () => ConversationEnvironment,
): TranscriptActions {
  const actions: TranscriptActions = {
    getMessages: (options) => getMessages(current(), options),
    getMessageAtPosition: (position) => getMessageAtPosition(current(), position),
    getMessageIds: () => getMessageIds(current()),
    getMessageById: (id) => getMessageById(current(), id),
    get: (id) => getMessageById(current(), id),
    searchMessages: (predicate) => searchConversationMessages(current(), predicate),
    getStatistics: () => getStatistics(current()),
    hasSystemMessage: () => hasSystemMessage(current()),
    getFirstSystemMessage: () => getFirstSystemMessage(current()),
    getSystemMessages: () => getSystemMessages(current()),
    toChatMessages: () => toChatMessages(current()),
    estimateTokens: (estimator) => estimateConversationTokens(current(), estimator, environment()),
    getRecentMessages: (count, options) => getRecentMessages(current(), count, options),
  };
  return actions;
}
