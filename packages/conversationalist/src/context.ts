import type { MultiModalContent } from '@lasercat/homogenaize';

import {
  assertConversationSafe,
  ensureConversationSafe,
} from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
  simpleTokenEstimator,
} from './environment';
import { ConversationalistError, createIntegrityError } from './errors';
import { copyContent } from './multi-modal';
import type { AssistantMessage, Conversation, Message, TokenEstimator } from './types';
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

const createMessageBlock = (
  message: Message,
  estimator: TokenEstimator,
): MessageBlock => ({
  messages: [message],
  minPosition: message.position,
  maxPosition: message.position,
  tokenCount: estimator(message),
});

const buildMessageBlocks = (
  messages: ReadonlyArray<Message>,
  estimator: TokenEstimator,
  preserveToolPairs: boolean,
): {
  blocks: MessageBlock[];
  messageToBlock: Map<string, MessageBlock>;
} => {
  if (!preserveToolPairs) {
    const blocks = messages.map((message) => createMessageBlock(message, estimator));
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
    if (message.role === 'tool-use' && message.toolCall) {
      const block = createMessageBlock(message, estimator);
      toolUses.set(message.toolCall.id, block);
      blocks.push(block);
      continue;
    }

    if (message.role === 'tool-result' && message.toolResult) {
      const existing = toolUses.get(message.toolResult.callId);
      if (existing) {
        existing.messages.push(message);
        existing.maxPosition = Math.max(existing.maxPosition, message.position);
        existing.tokenCount += estimator(message);
        continue;
      }

      const orphanBlock = createMessageBlock(message, estimator);
      orphanBlock.orphanToolResult = true;
      blocks.push(orphanBlock);
      continue;
    }

    blocks.push(createMessageBlock(message, estimator));
  }

  const filteredBlocks = blocks.filter((block) => !block.orphanToolResult);
  const messageToBlock = new Map<string, MessageBlock>();
  for (const block of filteredBlocks) {
    for (const message of block.messages) {
      messageToBlock.set(message.id, block);
    }
  }

  return { blocks: filteredBlocks, messageToBlock };
};

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
): number {
  let estimator = estimateTokens;
  let env = environment;

  if (
    !environment &&
    estimateTokens &&
    isConversationEnvironmentParameter(estimateTokens)
  ) {
    env = estimateTokens;
    estimator = undefined;
  }

  const resolvedEnvironment = resolveConversationEnvironment(env);
  const finalEstimator =
    typeof estimator === 'function' ? estimator : resolvedEnvironment.estimateTokens;

  return getOrderedMessages(conversation).reduce(
    (total, message) => total + finalEstimator(message),
    0,
  );
}

/**
 * Options for truncateToTokenLimit.
 */
export interface TruncateOptions {
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
export function truncateToTokenLimit(
  conversation: Conversation,
  maxTokens: number,
  optionsOrEstimator?: TruncateOptions | TokenEstimator,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  assertConversationSafe(conversation);
  // Handle overloaded arguments
  let options: TruncateOptions = {};
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
  const estimator = options.estimateTokens ?? resolvedEnvironment.estimateTokens;
  const preserveSystem = options.preserveSystemMessages ?? true;
  const preserveLastN = options.preserveLastN ?? 0;
  const preserveToolPairs = options.preserveToolPairs ?? true;

  // Calculate current token count
  const currentTokens = estimateConversationTokens(
    conversation,
    estimator,
    resolvedEnvironment,
  );
  if (currentTokens <= maxTokens) {
    return conversation;
  }

  const now = resolvedEnvironment.now();

  const orderedMessages = getOrderedMessages(conversation);
  const { blocks, messageToBlock } = buildMessageBlocks(
    orderedMessages,
    estimator,
    preserveToolPairs,
  );

  const systemMessages = preserveSystem
    ? orderedMessages.filter((m) => m.role === 'system')
    : [];
  const nonSystemMessages = orderedMessages.filter((m) => m.role !== 'system');
  const protectedMessages =
    preserveLastN > 0 ? nonSystemMessages.slice(-preserveLastN) : [];

  const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
  const protectedBlocks = collectBlocksForMessages(protectedMessages, messageToBlock);
  const lockedBlocks = new Set([...systemBlocks, ...protectedBlocks]);
  const removableBlocks = blocks.filter((block) => !lockedBlocks.has(block));

  const systemTokens = systemBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
  const protectedTokens = protectedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  const availableTokens = maxTokens - systemTokens - protectedTokens;

  let selectedBlocks: MessageBlock[] = [];
  if (availableTokens <= 0) {
    selectedBlocks = [...systemBlocks, ...protectedBlocks];
  } else {
    const sortedRemovable = [...removableBlocks].sort(
      (a, b) => a.maxPosition - b.maxPosition,
    );
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

    selectedBlocks = [...systemBlocks, ...keptRemovable, ...protectedBlocks];
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
  const keptMessages = ordered.filter((m) => m.position >= position);
  const systemBlocks = collectBlocksForMessages(systemMessages, messageToBlock);
  const keptBlocks = collectBlocksForMessages(keptMessages, messageToBlock);
  const allMessages = collectMessagesFromBlocks([...systemBlocks, ...keptBlocks]);

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
