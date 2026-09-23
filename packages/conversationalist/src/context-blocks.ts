import { ensureConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { ConversationalistError, createIntegrityError } from './errors';
import type { MultiModalContent } from './multi-modal';
import type {
  AssistantMessage,
  AsyncConversationTokenEstimator,
  ConversationHistory as Conversation,
  ConversationTokenEstimator,
  Message,
  TokenEstimator,
} from './types';
import { createMessage, isAssistantMessage } from './utilities';

export const cloneMessageWithPosition = (
  message: Message,
  position: number,
  content: string | ReadonlyArray<MultiModalContent>,
): Message => {
  const baseMessage = {
    id: message.id,
    role: message.role,
    content,
    position,
    createdAt: message.createdAt,
    metadata: { ...message.metadata },
    hidden: message.hidden,
    toolCall: message.toolCall ? { ...message.toolCall } : undefined,
    toolResult: message.toolResult ? { ...message.toolResult } : undefined,
    tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : undefined,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    const assistantMessage: AssistantMessage = {
      ...baseMessage,
      role: 'assistant',
      goalCompleted: message.goalCompleted,
    };
    return createMessage(assistantMessage);
  }

  return createMessage(baseMessage);
};

export type MessageBlock = {
  messages: Message[];
  minPosition: number;
  maxPosition: number;
  tokenCount: number;
  orphanToolResult?: boolean;
};

export type MaybePromise<T> = T | Promise<T>;

export interface EstimateConversationTokensOptions {
  estimateTokens?: TokenEstimator;
  estimateConversationTokens?: ConversationTokenEstimator;
}

export interface AsyncEstimateConversationTokensOptions {
  estimateTokens?: TokenEstimator;
  estimateConversationTokens: AsyncConversationTokenEstimator;
}

export type EstimateOptions =
  EstimateConversationTokensOptions | AsyncEstimateConversationTokensOptions;

export const isPromiseLike = <T>(value: MaybePromise<T>): value is Promise<T> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in value &&
  typeof value.then === 'function';

export const hasConversationTokenEstimator = (
  value: unknown,
): value is EstimateOptions & {
  estimateConversationTokens: ConversationTokenEstimator | AsyncConversationTokenEstimator;
} =>
  Boolean(
    value &&
    typeof value === 'object' &&
    'estimateConversationTokens' in value &&
    typeof value.estimateConversationTokens === 'function',
  );

export const createMessageBlock = (message: Message): MessageBlock => ({
  messages: [message],
  minPosition: message.position,
  maxPosition: message.position,
  tokenCount: 0,
});

export const estimateMessageBlockTokens = (
  messages: ReadonlyArray<Message>,
  options: EstimateOptions,
  environment: ConversationEnvironment,
): MaybePromise<number> => {
  if (options.estimateConversationTokens) {
    return options.estimateConversationTokens(messages);
  }

  const estimator = options.estimateTokens ?? environment.estimateTokens;
  return messages.reduce((total, message) => total + estimator(message), 0);
};

type BlockBuildResult = {
  blocks: MessageBlock[];
  messageToBlock: Map<string, MessageBlock>;
};

const buildIndependentBlocks = (
  messages: ReadonlyArray<Message>,
  estimateBlockTokens: (messages: ReadonlyArray<Message>) => number,
): BlockBuildResult => {
  const blocks = messages.map((message) => createMessageBlock(message));
  for (const block of blocks) block.tokenCount = estimateBlockTokens(block.messages);
  const messageToBlock = new Map<string, MessageBlock>();
  for (const block of blocks) {
    const message = block.messages[0];
    if (message) messageToBlock.set(message.id, block);
  }
  return { blocks, messageToBlock };
};

const buildPairedBlocks = (
  messages: ReadonlyArray<Message>,
  estimateBlockTokens: (messages: ReadonlyArray<Message>) => number,
): BlockBuildResult => {
  const blocks: MessageBlock[] = [];
  const toolUses = new Map<string, MessageBlock>();
  for (const message of messages) {
    if (message.role === 'tool-call' && message.toolCall) {
      const block = createMessageBlock(message);
      toolUses.set(message.toolCall.id, block);
      blocks.push(block);
      continue;
    }
    if (message.role === 'tool-result' && message.toolResult) {
      const existing = toolUses.get(message.toolResult.callId);
      if (existing) {
        existing.messages.push(message);
        existing.maxPosition = Math.max(existing.maxPosition, message.position);
        continue;
      }
      const orphanBlock = createMessageBlock(message);
      orphanBlock.orphanToolResult = true;
      blocks.push(orphanBlock);
      continue;
    }
    blocks.push(createMessageBlock(message));
  }
  const filteredBlocks = blocks.filter((block) => !block.orphanToolResult);
  for (const block of filteredBlocks) block.tokenCount = estimateBlockTokens(block.messages);
  const messageToBlock = new Map<string, MessageBlock>();
  for (const block of filteredBlocks) {
    for (const message of block.messages) messageToBlock.set(message.id, block);
  }
  return { blocks: filteredBlocks, messageToBlock };
};

export const buildMessageBlocks = (
  messages: ReadonlyArray<Message>,
  estimateBlockTokens: (messages: ReadonlyArray<Message>) => number,
  preserveToolPairs: boolean,
): BlockBuildResult =>
  preserveToolPairs
    ? buildPairedBlocks(messages, estimateBlockTokens)
    : buildIndependentBlocks(messages, estimateBlockTokens);

export const estimateBlocksAsConversation = (
  blocks: ReadonlyArray<MessageBlock>,
  options: EstimateOptions,
  environment: ConversationEnvironment,
): MaybePromise<number> =>
  estimateMessageBlockTokens(collectMessagesFromBlocks(blocks), options, environment);

export const collectBlocksForMessages = (
  messages: ReadonlyArray<Message>,
  messageToBlock: Map<string, MessageBlock>,
): MessageBlock[] => {
  const blocks: MessageBlock[] = [];
  const seen = new Set<MessageBlock>();

  for (const message of messages) {
    const block = messageToBlock.get(message.id);
    if (block && !seen.has(block)) {
      seen.add(block);
      blocks.push(block);
    }
  }

  return blocks;
};

export const collectMessagesFromBlocks = (blocks: ReadonlyArray<MessageBlock>): Message[] => {
  const messages: Message[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    for (const message of block.messages) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        messages.push(message);
      }
    }
  }

  return messages.toSorted((a, b) => a.position - b.position);
};

export const ensureTruncationSafe = (
  conversation: Conversation,
  preserveToolPairs: boolean,
  operation:
    | 'truncateToTokenLimit'
    | 'truncateFromPosition'
    | 'rewindBeforePosition'
    | 'rewindBeforeMessage',
): Conversation => {
  try {
    return ensureConversationSafe(conversation);
  } catch (error) {
    if (
      !preserveToolPairs &&
      error instanceof ConversationalistError &&
      error.code === 'error:integrity'
    )
      throw createIntegrityError(
        `${operation} produced invalid tool linkage; use preserveToolPairs: true to keep tool interactions intact`,
        { preserveToolPairs, issues: error.context?.['issues'] },
      );
    /* v8 ignore next */
    throw error;
  }
};
