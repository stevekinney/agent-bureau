import {
  type AsyncEstimateConversationTokensOptions,
  type EstimateConversationTokensOptions,
  type MaybePromise,
  type MessageBlock,
  buildMessageBlocks,
  cloneMessageWithPosition,
  collectBlocksForMessages,
  collectMessagesFromBlocks,
  ensureTruncationSafe,
  estimateBlocksAsConversation,
  estimateMessageBlockTokens,
  isPromiseLike,
} from './context-blocks';
import { assertConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { isConversationEnvironmentParameter, resolveConversationEnvironment } from './environment';
import { copyContent } from './multi-modal';
import { isStreamingMessage } from './streaming';
import type { ConversationHistory as Conversation, Message, TokenEstimator } from './types';
import { toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

/**
 * Options for truncateToTokenLimit.
 */
export interface TruncateOptions extends EstimateConversationTokensOptions {
  preserveSystemMessages?: boolean;
  preserveLastN?: number;
  preserveToolPairs?: boolean;
}

export interface AsyncTruncateOptions extends AsyncEstimateConversationTokensOptions {
  estimateTokens?: TokenEstimator;
  preserveSystemMessages?: boolean;
  preserveLastN?: number;
  preserveToolPairs?: boolean;
}

/**
 * Truncates conversation to fit within an estimated token limit.
 * Removes oldest messages first while preserving system messages and optionally the last N messages.
 * If no estimator is provided, the environment's default estimator is used.
 * Tool interactions are preserved as atomic blocks by default.
 */
type ResolvedTruncateOptions = TruncateOptions | AsyncTruncateOptions;

function resolveTruncateArguments(
  optionsOrEstimator:
    ResolvedTruncateOptions | TokenEstimator | Partial<ConversationEnvironment> | undefined,
  environment: Partial<ConversationEnvironment> | undefined,
): { options: ResolvedTruncateOptions; environment: Partial<ConversationEnvironment> | undefined } {
  if (typeof optionsOrEstimator === 'function') {
    return { options: { estimateTokens: optionsOrEstimator }, environment };
  }
  if (!optionsOrEstimator) return { options: {}, environment };
  if (!environment && isConversationEnvironmentParameter(optionsOrEstimator)) {
    const candidate = optionsOrEstimator;
    const hasEnvironmentFields = Boolean(
      candidate.now ||
      candidate.randomId ||
      (Array.isArray(candidate.plugins) && candidate.plugins.length > 0),
    );
    if (hasEnvironmentFields) return { options: {}, environment: candidate };
  }
  return { options: optionsOrEstimator, environment };
}

const truncateToTokenLimitFromBlocks = (
  conversation: Conversation,
  maxTokens: number,
  orderedMessages: ReadonlyArray<Message>,
  blocks: ReadonlyArray<MessageBlock>,
  messageToBlock: Map<string, MessageBlock>,
  options: ResolvedTruncateOptions,
  environment: ConversationEnvironment,
): Conversation => {
  const now = environment.now();
  const preserveSystem = options.preserveSystemMessages ?? true;
  const preserveLastN = options.preserveLastN ?? 0;
  const preserveToolPairs = options.preserveToolPairs ?? true;

  const systemMessages = preserveSystem ? orderedMessages.filter((m) => m.role === 'system') : [];
  const nonSystemMessages = orderedMessages.filter((m) => m.role !== 'system');
  const protectedMessages = preserveLastN > 0 ? nonSystemMessages.slice(-preserveLastN) : [];
  const streamingMessages = orderedMessages.filter(isStreamingMessage);

  const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
  const protectedBlocks = collectBlocksForMessages(protectedMessages, messageToBlock);
  const streamingBlocks = collectBlocksForMessages(streamingMessages, messageToBlock);
  const lockedBlocks = new Set([...systemBlocks, ...protectedBlocks, ...streamingBlocks]);
  const removableBlocks = blocks.filter((block) => !lockedBlocks.has(block));

  const systemTokens = systemBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
  const protectedTokens = protectedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
  const streamingTokens = streamingBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
  const availableTokens = maxTokens - systemTokens - protectedTokens - streamingTokens;

  let selectedBlocks: MessageBlock[];
  if (availableTokens <= 0) {
    selectedBlocks = [...systemBlocks, ...protectedBlocks, ...streamingBlocks];
  } else {
    const sortedRemovable = [...removableBlocks].toSorted((a, b) => a.maxPosition - b.maxPosition);
    const keptRemovable: MessageBlock[] = [];
    let usedTokens = 0;

    for (let i = sortedRemovable.length - 1; i >= 0; i--) {
      const block = sortedRemovable[i]!;
      if (usedTokens + block.tokenCount <= availableTokens) {
        keptRemovable.unshift(block);
        usedTokens += block.tokenCount;
      } else {
        break;
      }
    }

    selectedBlocks = [...systemBlocks, ...keptRemovable, ...streamingBlocks, ...protectedBlocks];
  }

  const allMessages = collectMessagesFromBlocks(selectedBlocks);
  const renumbered = allMessages.map((message, index) =>
    cloneMessageWithPosition(message, index, copyContent(message.content)),
  );

  const next = toReadonly({
    ...conversation,
    ids: renumbered.map((message) => message.id),
    messages: toIdRecord(renumbered),
    updatedAt: now,
  });
  return ensureTruncationSafe(next, preserveToolPairs, 'truncateToTokenLimit');
};

const truncateToTokenLimitWithConversationEstimator = (
  conversation: Conversation,
  maxTokens: number,
  orderedMessages: ReadonlyArray<Message>,
  options: ResolvedTruncateOptions,
  environment: ConversationEnvironment,
): MaybePromise<Conversation> => {
  const preserveSystem = options.preserveSystemMessages ?? true;
  const preserveLastN = options.preserveLastN ?? 0;
  const preserveToolPairs = options.preserveToolPairs ?? true;
  const { blocks, messageToBlock } = buildMessageBlocks(
    orderedMessages,
    () => 0,
    preserveToolPairs,
  );

  const countAllMessages = estimateMessageBlockTokens(orderedMessages, options, environment);

  const selectBlocks = (currentTokens: number): MaybePromise<ReadonlyArray<MessageBlock>> => {
    if (currentTokens <= maxTokens) {
      return blocks;
    }

    const systemMessages = preserveSystem ? orderedMessages.filter((m) => m.role === 'system') : [];
    const nonSystemMessages = orderedMessages.filter((m) => m.role !== 'system');
    const protectedMessages = preserveLastN > 0 ? nonSystemMessages.slice(-preserveLastN) : [];
    const streamingMessages = orderedMessages.filter(isStreamingMessage);

    const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
    const protectedBlocks = collectBlocksForMessages(protectedMessages, messageToBlock);
    const streamingBlocks = collectBlocksForMessages(streamingMessages, messageToBlock);
    const lockedBlocks = new Set([...systemBlocks, ...protectedBlocks, ...streamingBlocks]);
    const removableBlocks = blocks.filter((block) => !lockedBlocks.has(block));
    const selectedLockedBlocks = [...lockedBlocks];
    const sortedRemovable = [...removableBlocks].toSorted((a, b) => a.maxPosition - b.maxPosition);

    const lockedTokens = estimateBlocksAsConversation(selectedLockedBlocks, options, environment);

    const selectFromNewest = (
      lockedTokenCount: number,
    ): MaybePromise<ReadonlyArray<MessageBlock>> => {
      if (lockedTokenCount >= maxTokens) {
        return selectedLockedBlocks;
      }

      const keptRemovable: MessageBlock[] = [];

      for (let index = sortedRemovable.length - 1; index >= 0; index--) {
        const candidate = sortedRemovable[index]!;
        const candidateBlocks = [...selectedLockedBlocks, candidate, ...keptRemovable];
        const candidateTokens = estimateBlocksAsConversation(candidateBlocks, options, environment);

        if (isPromiseLike(candidateTokens)) {
          return candidateTokens.then(async (resolvedCandidateTokens) => {
            if (resolvedCandidateTokens > maxTokens) {
              return [...selectedLockedBlocks, ...keptRemovable];
            }

            keptRemovable.unshift(candidate);
            for (let asyncIndex = index - 1; asyncIndex >= 0; asyncIndex--) {
              const asyncCandidate = sortedRemovable[asyncIndex]!;
              const asyncCandidateBlocks = [
                ...selectedLockedBlocks,
                asyncCandidate,
                ...keptRemovable,
              ];
              const asyncCandidateTokens = await estimateBlocksAsConversation(
                asyncCandidateBlocks,
                options,
                environment,
              );

              if (asyncCandidateTokens > maxTokens) {
                break;
              }

              keptRemovable.unshift(asyncCandidate);
            }

            return [...selectedLockedBlocks, ...keptRemovable];
          });
        }

        if (candidateTokens > maxTokens) {
          break;
        }

        keptRemovable.unshift(candidate);
      }

      return [...selectedLockedBlocks, ...keptRemovable];
    };

    if (isPromiseLike(lockedTokens)) {
      return lockedTokens.then(selectFromNewest);
    }

    return selectFromNewest(lockedTokens);
  };

  const finish = (selectedBlocks: ReadonlyArray<MessageBlock>): Conversation => {
    if (selectedBlocks === blocks) {
      return conversation;
    }

    const allMessages = collectMessagesFromBlocks(selectedBlocks);
    const renumbered = allMessages.map((message, index) =>
      cloneMessageWithPosition(message, index, copyContent(message.content)),
    );

    const next = toReadonly({
      ...conversation,
      ids: renumbered.map((message) => message.id),
      messages: toIdRecord(renumbered),
      updatedAt: environment.now(),
    });
    return ensureTruncationSafe(next, preserveToolPairs, 'truncateToTokenLimit');
  };

  const finishAsync = async (currentTokens: Promise<number>): Promise<Conversation> => {
    const selectedBlocks = await selectBlocks(await currentTokens);
    return finish(selectedBlocks);
  };

  if (isPromiseLike(countAllMessages)) {
    return finishAsync(countAllMessages);
  }

  const selectedBlocks = selectBlocks(countAllMessages);
  return isPromiseLike(selectedBlocks) ? selectedBlocks.then(finish) : finish(selectedBlocks);
};

export function truncateToTokenLimit(
  conversation: Conversation,
  maxTokens: number,
  optionsOrEstimator?: TruncateOptions | TokenEstimator,
  environment?: Partial<ConversationEnvironment>,
): Conversation;
export function truncateToTokenLimit(
  conversation: Conversation,
  maxTokens: number,
  options: AsyncTruncateOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<Conversation>;
export function truncateToTokenLimit(
  conversation: Conversation,
  maxTokens: number,
  optionsOrEstimator?: ResolvedTruncateOptions | TokenEstimator | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): MaybePromise<Conversation> {
  assertConversationSafe(conversation);
  const resolvedArguments = resolveTruncateArguments(optionsOrEstimator, environment);
  const options = resolvedArguments.options;
  const env = resolvedArguments.environment;

  const resolvedEnvironment = resolveConversationEnvironment(env);
  const preserveToolPairs = options.preserveToolPairs ?? true;
  const orderedMessages = getOrderedMessages(conversation);

  if (options.estimateConversationTokens) {
    return truncateToTokenLimitWithConversationEstimator(
      conversation,
      maxTokens,
      orderedMessages,
      options,
      resolvedEnvironment,
    );
  }

  const estimateBlockTokens = (messages: ReadonlyArray<Message>): number => {
    const estimated = estimateMessageBlockTokens(messages, options, resolvedEnvironment);
    if (typeof estimated === 'number') return estimated;
    throw new Error('Synchronous token estimation returned a promise.');
  };

  // Calculate current token count
  const currentTokens = estimateBlockTokens(orderedMessages);

  if (currentTokens <= maxTokens) {
    return conversation;
  }

  const { blocks, messageToBlock } = buildMessageBlocks(
    orderedMessages,
    estimateBlockTokens,
    preserveToolPairs,
  );
  return truncateToTokenLimitFromBlocks(
    conversation,
    maxTokens,
    orderedMessages,
    blocks,
    messageToBlock,
    options,
    resolvedEnvironment,
  );
}
