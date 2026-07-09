import { assertConversationSafe, ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
  simpleTokenEstimator,
} from './environment';
import { ConversationalistError, createIntegrityError } from './errors';
import type { MultiModalContent } from './multi-modal';
import { copyContent } from './multi-modal';
import { isStreamingMessage } from './streaming';
import type {
  AssistantMessage,
  AsyncConversationTokenEstimator,
  ConversationHistory as Conversation,
  ConversationTokenEstimator,
  Message,
  TokenEstimator,
} from './types';
import { createMessage, isAssistantMessage, toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

export { simpleTokenEstimator };

const cloneMessageWithPosition = (
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

type MessageBlock = {
  messages: Message[];
  minPosition: number;
  maxPosition: number;
  tokenCount: number;
  orphanToolResult?: boolean;
};

type MaybePromise<T> = T | Promise<T>;

export interface EstimateConversationTokensOptions {
  estimateTokens?: TokenEstimator;
  estimateConversationTokens?: ConversationTokenEstimator;
}

export interface AsyncEstimateConversationTokensOptions {
  estimateTokens?: TokenEstimator;
  estimateConversationTokens: AsyncConversationTokenEstimator;
}

type EstimateOptions = EstimateConversationTokensOptions | AsyncEstimateConversationTokensOptions;

const isPromiseLike = <T>(value: MaybePromise<T>): value is Promise<T> =>
  typeof (value as Promise<T>)?.then === 'function';

const hasConversationTokenEstimator = (
  value: unknown,
): value is EstimateOptions & {
  estimateConversationTokens: ConversationTokenEstimator | AsyncConversationTokenEstimator;
} =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['estimateConversationTokens'] === 'function',
  );

const createMessageBlock = (message: Message): MessageBlock => ({
  messages: [message],
  minPosition: message.position,
  maxPosition: message.position,
  tokenCount: 0,
});

const estimateMessageBlockTokens = (
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

const buildMessageBlocks = (
  messages: ReadonlyArray<Message>,
  estimateBlockTokens: (messages: ReadonlyArray<Message>) => number,
  preserveToolPairs: boolean,
): {
  blocks: MessageBlock[];
  messageToBlock: Map<string, MessageBlock>;
} => {
  if (!preserveToolPairs) {
    const blocks = messages.map((message) => createMessageBlock(message));
    for (const block of blocks) {
      block.tokenCount = estimateBlockTokens(block.messages);
    }
    const messageToBlock = new Map<string, MessageBlock>();
    for (const block of blocks) {
      const message = block.messages[0];
      if (message) {
        messageToBlock.set(message.id, block);
      }
    }
    return { blocks, messageToBlock };
  }

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
  for (const block of filteredBlocks) {
    block.tokenCount = estimateBlockTokens(block.messages);
  }
  const messageToBlock = new Map<string, MessageBlock>();
  for (const block of filteredBlocks) {
    for (const message of block.messages) {
      messageToBlock.set(message.id, block);
    }
  }

  return { blocks: filteredBlocks, messageToBlock };
};

const estimateBlocksAsConversation = (
  blocks: ReadonlyArray<MessageBlock>,
  options: EstimateOptions,
  environment: ConversationEnvironment,
): MaybePromise<number> =>
  estimateMessageBlockTokens(collectMessagesFromBlocks(blocks), options, environment);

const collectBlocksForMessages = (
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

const collectMessagesFromBlocks = (blocks: ReadonlyArray<MessageBlock>): Message[] => {
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

  messages.sort((a, b) => a.position - b.position);
  return messages;
};

const ensureTruncationSafe = (
  conversation: Conversation,
  preserveToolPairs: boolean,
  operation: 'truncateToTokenLimit' | 'truncateFromPosition',
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

/**
 * Estimates total tokens in a conversation using the provided estimator function.
 * If no estimator is provided, the environment's default estimator is used.
 */
export function estimateConversationTokens(
  conversation: Conversation,
  estimateTokens?: TokenEstimator,
  environment?: Partial<ConversationEnvironment>,
): number;
export function estimateConversationTokens(
  conversation: Conversation,
  options: EstimateConversationTokensOptions,
  environment?: Partial<ConversationEnvironment>,
): number;
export function estimateConversationTokens(
  conversation: Conversation,
  options: AsyncEstimateConversationTokensOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<number>;
export function estimateConversationTokens(
  conversation: Conversation,
  optionsOrEstimator?: EstimateOptions | TokenEstimator | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): MaybePromise<number> {
  let options: EstimateOptions = {};
  let env = environment;

  if (typeof optionsOrEstimator === 'function') {
    options = { estimateTokens: optionsOrEstimator };
  } else if (optionsOrEstimator) {
    if (
      !environment &&
      !hasConversationTokenEstimator(optionsOrEstimator) &&
      isConversationEnvironmentParameter(optionsOrEstimator)
    ) {
      env = optionsOrEstimator;
    } else {
      options = optionsOrEstimator as EstimateOptions;
    }
  }

  const resolvedEnvironment = resolveConversationEnvironment(env);
  return estimateMessageBlockTokens(getOrderedMessages(conversation), options, resolvedEnvironment);
}

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
    const sortedRemovable = [...removableBlocks].sort((a, b) => a.maxPosition - b.maxPosition);
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
    const sortedRemovable = [...removableBlocks].sort((a, b) => a.maxPosition - b.maxPosition);

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
  // Handle overloaded arguments
  let options: ResolvedTruncateOptions = {};
  let env = environment;

  if (typeof optionsOrEstimator === 'function') {
    options = { estimateTokens: optionsOrEstimator };
  } else if (optionsOrEstimator) {
    // If environment was not explicitly passed, check if optionsOrEstimator IS the environment
    if (!environment && isConversationEnvironmentParameter(optionsOrEstimator)) {
      // Disambiguate between TruncateOptions and ConversationEnvironment.
      // Environment fields (now, randomId, non-empty plugins) take priority because they're
      // exclusive to ConversationEnvironment, while estimateTokens exists in both types.
      const candidate = optionsOrEstimator as Record<string, unknown>;
      const hasEnvFields = !!(
        candidate['now'] ||
        candidate['randomId'] ||
        (Array.isArray(candidate['plugins']) && candidate['plugins'].length > 0)
      );

      if (hasEnvFields) {
        // Treat as environment, not options
        env = optionsOrEstimator;
      } else {
        // Has estimateTokens but no exclusive environment fields, treat as options
        options = optionsOrEstimator;
      }
    } else {
      options = optionsOrEstimator;
    }
  }

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

  const estimateBlockTokens = (messages: ReadonlyArray<Message>): number =>
    estimateMessageBlockTokens(messages, options, resolvedEnvironment) as number;

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

/**
 * Returns the last N messages from the conversation.
 * By default excludes system messages and hidden messages.
 * Tool interactions are preserved as atomic blocks by default.
 */
export function getRecentMessages(
  conversation: Conversation,
  count: number,
  options?: {
    includeHidden?: boolean;
    includeSystem?: boolean;
    preserveToolPairs?: boolean;
  },
): ReadonlyArray<Message> {
  const includeHidden = options?.includeHidden ?? false;
  const includeSystem = options?.includeSystem ?? false;
  const preserveToolPairs = options?.preserveToolPairs ?? true;

  const filtered = getOrderedMessages(conversation).filter((m) => {
    if (!includeHidden && m.hidden) return false;
    if (!includeSystem && m.role === 'system') return false;
    return true;
  });

  if (!preserveToolPairs) {
    return filtered.slice(-count);
  }

  const { messageToBlock } = buildMessageBlocks(filtered, () => 0, preserveToolPairs);
  const tail = filtered.slice(-count);
  const blocks = collectBlocksForMessages(tail, messageToBlock);
  return collectMessagesFromBlocks(blocks);
}

/**
 * Truncates conversation to keep only messages from the specified position onwards.
 * Optionally preserves system messages regardless of position.
 * Tool interactions are preserved as atomic blocks by default.
 */
export function truncateFromPosition(
  conversation: Conversation,
  position: number,
  options?: {
    preserveSystemMessages?: boolean;
    preserveToolPairs?: boolean;
  },
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  assertConversationSafe(conversation);
  const preserveSystem = options?.preserveSystemMessages ?? true;
  const preserveToolPairs = options?.preserveToolPairs ?? true;
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  const ordered = getOrderedMessages(conversation);
  const { messageToBlock } = buildMessageBlocks(ordered, () => 0, preserveToolPairs);
  const systemMessages = preserveSystem
    ? ordered.filter((m) => m.role === 'system' && m.position < position)
    : [];
  const streamingMessages = ordered.filter((m) => isStreamingMessage(m) && m.position < position);
  const keptMessages = ordered.filter((m) => m.position >= position);
  const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
  const streamingBlocks = collectBlocksForMessages(streamingMessages, messageToBlock);
  const keptBlocks = collectBlocksForMessages(keptMessages, messageToBlock);
  const allMessages = collectMessagesFromBlocks([
    ...systemBlocks,
    ...streamingBlocks,
    ...keptBlocks,
  ]);

  // Renumber positions
  const renumbered = allMessages.map((message, index) =>
    cloneMessageWithPosition(message, index, copyContent(message.content)),
  );

  const next = toReadonly({
    ...conversation,
    ids: renumbered.map((message) => message.id),
    messages: toIdRecord(renumbered),
    updatedAt: now,
  });
  return ensureTruncationSafe(next, preserveToolPairs, 'truncateFromPosition');
}
