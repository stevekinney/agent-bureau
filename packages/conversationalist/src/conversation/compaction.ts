import type { ConversationEnvironment } from '../environment';
import { resolveConversationEnvironment } from '../environment';
import type {
  ConversationHistory,
  Message,
  MessageInput,
  TokenEstimator,
} from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';
import { appendMessages } from './append';
import { getMessages } from './query';
import { getSystemMessages } from './system-messages';
import { ensureConversationSafe } from './validation';

/**
 * Options for conversation compaction.
 */
export interface CompactionOptions {
  /**
   * Maximum token budget for the conversation.
   * If the conversation exceeds this, compaction will be triggered.
   */
  maxTokens: number;

  /**
   * Number of recent messages to preserve without compaction.
   * @default 5
   */
  preserveRecentCount?: number;

  /**
   * Whether to preserve all system messages during compaction.
   * @default true
   */
  preserveSystemMessages?: boolean;

  /**
   * Token estimator function. If not provided, uses default estimator.
   */
  tokenEstimator?: TokenEstimator;
}

/**
 * Function that summarizes a set of messages.
 * Can be synchronous or asynchronous.
 */
export type MessageSummarizer = (
  messages: ReadonlyArray<Message>,
) => Promise<string> | string;

/**
 * Replaces the content of a tool result message with a summary,
 * while preserving all other fields.
 *
 * @param message - The message to strip
 * @param summary - The summary text to use
 * @returns A new message with stripped content
 */
export function stripToolResultDetails(message: Message, summary: string): Message {
  // Only modify tool-result messages
  if (message.role !== 'tool-result') {
    return message;
  }

  // Create a new message with updated content and tool result content
  const updated: Message = {
    ...message,
    content: summary,
  };

  // If there's a tool result, update its content field as well
  if (updated.toolResult) {
    updated.toolResult = {
      ...updated.toolResult,
      content: summary,
    };
  }

  return updated;
}

/**
 * Represents a chunk of compactable messages.
 */
interface CompactionChunk {
  messages: ReadonlyArray<Message>;
  tokenCount: number;
}

/**
 * Calculates total tokens for a set of messages using the provided estimator.
 */
function calculateTokens(
  messages: ReadonlyArray<Message>,
  estimator: TokenEstimator,
): number {
  return messages.reduce((total, message) => total + estimator(message), 0);
}

/**
 * Chunks messages into groups for compaction, respecting token limits and preserving recent messages.
 */
function chunkMessagesForCompaction(
  messages: ReadonlyArray<Message>,
  options: CompactionOptions,
  estimator: TokenEstimator,
): CompactionChunk[] {
  const preserveRecentCount = options.preserveRecentCount ?? 5;
  const chunks: CompactionChunk[] = [];

  if (messages.length <= preserveRecentCount) {
    // Not enough messages to warrant chunking
    return [];
  }

  // Messages to compact: all except the recent ones
  const compactableMessages = messages.slice(0, messages.length - preserveRecentCount);

  // Start chunking from the beginning
  let currentChunk: Message[] = [];
  let currentTokenCount = 0;

  for (const message of compactableMessages) {
    const messageTokens = estimator(message);
    const wouldExceed = currentTokenCount + messageTokens > options.maxTokens / 2; // Use half budget per chunk

    if (wouldExceed && currentChunk.length > 0) {
      // Save current chunk and start a new one
      chunks.push({
        messages: currentChunk,
        tokenCount: currentTokenCount,
      });
      currentChunk = [message];
      currentTokenCount = messageTokens;
    } else {
      currentChunk.push(message);
      currentTokenCount += messageTokens;
    }
  }

  // Add the last chunk if it has messages
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      tokenCount: currentTokenCount,
    });
  }

  return chunks;
}

/**
 * Compacts a conversation by summarizing older messages and removing excess tool results.
 *
 * @param conversation - The conversation to compact
 * @param options - Compaction options
 * @param summarizer - Function that summarizes messages. If not provided, returns original conversation.
 * @param environment - Environment for timestamps (optional)
 * @returns A new compacted conversation, or the original if no compaction needed
 */
export function compactConversation(
  conversation: ConversationHistory,
  options: CompactionOptions,
  summarizer?: MessageSummarizer,
  environment?: Partial<ConversationEnvironment>,
): ConversationHistory | Promise<ConversationHistory> {
  const env = resolveConversationEnvironment(environment);
  const allMessages = getMessages(conversation, { includeHidden: true });

  if (allMessages.length === 0) {
    return conversation; // Nothing to compact
  }

  // Determine if compaction is needed
  const estimator = options.tokenEstimator || defaultTokenEstimator;
  const currentTokens = calculateTokens(allMessages, estimator);

  if (currentTokens <= options.maxTokens) {
    return conversation; // No compaction needed
  }

  if (!summarizer) {
    return conversation; // Can't compact without a summarizer
  }

  // Identify system messages and recent messages to preserve
  const systemMessages = getSystemMessages(conversation);
  const preserveRecentCount = options.preserveRecentCount ?? 5;
  const recentMessages = allMessages.slice(-preserveRecentCount);

  // Messages to potentially compact (exclude system messages)
  const nonSystemMessages = allMessages.filter((m) => m.role !== 'system');
  const compactableMessages = nonSystemMessages.slice(
    0,
    Math.max(0, nonSystemMessages.length - preserveRecentCount),
  );

  // Only compact if we have non-system messages to compact
  if (compactableMessages.length === 0) {
    return conversation; // Nothing to compact
  }

  // Filter system messages that should be preserved
  const systemsToPreserve = options.preserveSystemMessages ? systemMessages : [];

  // Chunk the compactable messages
  const chunks = chunkMessagesForCompaction(compactableMessages, options, estimator);

  if (chunks.length === 0) {
    return conversation; // No chunks generated
  }

  // Handle both sync and async summarizers
  const summarizeChunks = (): string[] | Promise<string[]> => {
    const results = chunks.map((chunk) => summarizer(chunk.messages));

    // Check if any result is a promise
    if (results.some((r) => r instanceof Promise)) {
      return Promise.all(results);
    }

    return results as string[];
  };

  const buildCompactedConversation = (summaries: string[]): ConversationHistory => {
    // Merge summaries with separator
    const mergedSummary = summaries.join('\n\n---\n\n');

    // Start with a new conversation preserving key properties
    let compacted: ConversationHistory = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      metadata: { ...conversation.metadata },
      ids: [],
      messages: {},
      createdAt: conversation.createdAt,
      updatedAt: env.now(),
    };

    compacted = ensureConversationSafe(toReadonly(compacted));

    // Re-add system messages to preserve
    const systemMessagesToAdd: MessageInput[] = systemsToPreserve.map((m) => {
      const content = typeof m.content === 'string' ? m.content : [...m.content];
      return {
        role: 'system' as const,
        content,
        metadata: m.metadata,
      };
    });

    if (systemMessagesToAdd.length > 0) {
      compacted = appendMessages(compacted, ...systemMessagesToAdd, env);
    }

    // Add compaction summary as a system message
    compacted = appendMessages(
      compacted,
      {
        role: 'system' as const,
        content: mergedSummary,
        metadata: { compactionSummary: true as const },
      },
      env,
    );

    // Re-add recent messages
    const recentMessagesToAdd: MessageInput[] = recentMessages.map((m) => {
      const content = typeof m.content === 'string' ? m.content : [...m.content];
      return {
        role: m.role,
        content,
        metadata: m.metadata,
        hidden: m.hidden,
        toolCall: m.toolCall,
        toolResult: m.toolResult,
        tokenUsage: m.tokenUsage,
      };
    });

    if (recentMessagesToAdd.length > 0) {
      compacted = appendMessages(compacted, ...recentMessagesToAdd, env);
    }

    return compacted;
  };

  const summaryResults = summarizeChunks();

  if (summaryResults instanceof Promise) {
    return summaryResults.then(buildCompactedConversation);
  }

  return buildCompactedConversation(summaryResults);
}

/**
 * Default token estimator that counts characters as a rough proxy for tokens.
 */
function defaultTokenEstimator(message: Message): number {
  let tokenCount = 0;

  // Count content tokens
  if (typeof message.content === 'string') {
    tokenCount += Math.ceil(message.content.length / 4); // Rough approximation
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item.type === 'text') {
        tokenCount += Math.ceil(item.text.length / 4);
      } else if (item.type === 'image') {
        // Rough estimate for images (varies by model)
        tokenCount += 85; // Claude's typical image token cost
      }
    }
  }

  // Count tool metadata tokens
  if (message.toolCall) {
    tokenCount += 50; // Rough estimate for tool call metadata
    if (message.toolCall.arguments) {
      tokenCount += Math.ceil(JSON.stringify(message.toolCall.arguments).length / 4);
    }
  }

  if (message.toolResult) {
    tokenCount += 50; // Rough estimate for tool result metadata
    if (message.toolResult.content) {
      tokenCount += Math.ceil(JSON.stringify(message.toolResult.content).length / 4);
    }
  }

  return Math.max(1, tokenCount); // At least 1 token per message
}
