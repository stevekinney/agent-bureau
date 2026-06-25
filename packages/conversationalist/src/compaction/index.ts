import { appendMessages } from '../conversation/append';
import { getMessages } from '../conversation/index';
import { ensureConversationSafe } from '../conversation/validation';
import type { ConversationEnvironment } from '../environment';
import { resolveConversationEnvironment, simpleTokenEstimator } from '../environment';
import type { MultiModalContent } from '../multi-modal';
import { isStreamingMessage } from '../streaming';
import type { ConversationHistory, Message, MessageInput } from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';

export type Summarizer = (
  messages: Message[],
  options?: { maxTokens?: number | undefined },
) => Promise<string>;

export interface CompactionOptions {
  preserveRecentCount?: number | undefined;
  preserveSystemMessages?: boolean | undefined;
  preserveToolPairs?: boolean | undefined;
  baseChunkRatio?: number | undefined;
  minimumChunkRatio?: number | undefined;
  safetyMargin?: number | undefined;
  maxSummaryTokens?: number | undefined;
}

export interface CompactionResult {
  compacted: boolean;
  chunksProcessed: number;
  messagesRemoved: number;
  summaryContent: string;
}

export function calculateChunkSize(
  totalTokens: number,
  averageMessageTokens: number,
  contextWindow: number,
  options?: CompactionOptions,
): number {
  const baseRatio = options?.baseChunkRatio ?? 0.4;
  const minRatio = options?.minimumChunkRatio ?? 0.15;
  const safety = options?.safetyMargin ?? 1.2;

  // If average message is > 10% of context, use minimum ratio
  const ratio = averageMessageTokens > contextWindow * 0.1 ? minRatio : baseRatio;
  return Math.max(1, Math.floor((totalTokens * ratio) / safety));
}

export function partitionMessages(
  conversation: ConversationHistory,
  options?: CompactionOptions,
  _environment?: Partial<ConversationEnvironment>,
): { compactable: Message[]; preserved: Message[] } {
  const preserveRecent = options?.preserveRecentCount ?? 4;
  const preserveSystem = options?.preserveSystemMessages ?? true;
  const preserveToolPairs = options?.preserveToolPairs ?? true;

  const allMessages = getMessages(conversation);

  // Separate system messages and streaming messages
  const systemMessages = preserveSystem ? allMessages.filter((m) => m.role === 'system') : [];
  const streamingMessages = allMessages.filter(isStreamingMessage);
  const nonSystem = allMessages.filter((m) => m.role !== 'system');

  if (nonSystem.length <= preserveRecent) {
    return { compactable: [], preserved: [...allMessages] };
  }

  // Recent N messages
  let recentMessages = nonSystem.slice(-preserveRecent);

  // If preserveToolPairs, ensure tool pairs are not split
  if (preserveToolPairs && recentMessages.length > 0) {
    const firstRecent = recentMessages[0]!;
    // If the first recent message is a tool-result, also include its tool-call
    if (firstRecent.role === 'tool-result' && firstRecent.toolResult) {
      const callId = firstRecent.toolResult.callId;
      const toolCallMsg = nonSystem.find(
        (m) => m.role === 'tool-call' && m.toolCall?.id === callId,
      );
      if (toolCallMsg && !recentMessages.includes(toolCallMsg)) {
        recentMessages = [toolCallMsg, ...recentMessages];
      }
    }
  }

  const preservedSet = new Set([
    ...systemMessages.map((m) => m.id),
    ...recentMessages.map((m) => m.id),
    ...streamingMessages.map((m) => m.id),
  ]);
  const compactable = allMessages.filter((m) => !preservedSet.has(m.id));
  const preserved = allMessages.filter((m) => preservedSet.has(m.id));

  return { compactable, preserved };
}

export function chunkMessages(
  messages: Message[],
  chunkTokenBudget: number,
  estimator: (message: Message) => number,
): Message[][] {
  if (messages.length === 0) return [];

  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const tokens = estimator(message);

    // Check if this is a tool-call that has a matching tool-result coming next
    let pairedMessages: Message[] = [message];
    let pairedTokens = tokens;

    if (message.role === 'tool-call' && message.toolCall) {
      // Look ahead for matching tool-result
      const nextIdx = i + 1;
      if (nextIdx < messages.length) {
        const next = messages[nextIdx]!;
        if (next.role === 'tool-result' && next.toolResult?.callId === message.toolCall.id) {
          pairedMessages = [message, next];
          pairedTokens = tokens + estimator(next);
          i++; // Skip the next message since we're including it
        }
      }
    }

    // If adding this would exceed budget and chunk is not empty, start new chunk
    if (currentTokens + pairedTokens > chunkTokenBudget && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(...pairedMessages);
    currentTokens += pairedTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

const STRIPPED_PLACEHOLDER = '[tool result]';

/**
 * Replaces structural tool-result/tool-use block payloads inside a content array
 * with a placeholder, mirroring the role-level tool-result stripping. Server-tool
 * results (web search/fetch, code execution) store stdout / fetched pages /
 * snippets inside assistant content, so compaction must shrink them there too.
 */
function stripStructuralToolBlocks(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    switch (part.type) {
      case 'server_tool_use':
        return { ...part, input: STRIPPED_PLACEHOLDER };
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
      case 'code_execution_tool_result':
      case 'bash_code_execution_tool_result':
      case 'text_editor_code_execution_tool_result':
        return { ...part, content: STRIPPED_PLACEHOLDER };
      default:
        return part;
    }
  });
}

export function stripToolResultDetails(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role === 'tool-result' && message.toolResult) {
      return {
        ...message,
        content: STRIPPED_PLACEHOLDER,
        toolResult: {
          ...message.toolResult,
          content: STRIPPED_PLACEHOLDER,
        },
      } as Message;
    }
    // Structural tool-result blocks live inside assistant content; strip them too.
    if (typeof message.content !== 'string') {
      return { ...message, content: stripStructuralToolBlocks(message.content) } as Message;
    }
    return message;
  });
}

export async function compactConversation(
  conversation: ConversationHistory,
  summarizer: Summarizer,
  options?: CompactionOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<{ conversation: ConversationHistory; result: CompactionResult }> {
  const env = resolveConversationEnvironment(environment);
  const estimator = env.estimateTokens ?? simpleTokenEstimator;

  const { compactable, preserved } = partitionMessages(conversation, options, environment);

  if (compactable.length === 0) {
    return {
      conversation,
      result: {
        compacted: false,
        chunksProcessed: 0,
        messagesRemoved: 0,
        summaryContent: '',
      },
    };
  }

  // Estimate tokens for chunking
  const totalTokens = compactable.reduce((sum, m) => sum + estimator(m), 0);
  const avgTokens = totalTokens / compactable.length;
  const contextWindow = totalTokens * 3; // Rough context estimate

  const chunkBudget = calculateChunkSize(totalTokens, avgTokens, contextWindow, options);
  const stripped = stripToolResultDetails(compactable);
  const chunks = chunkMessages(stripped, chunkBudget, estimator);

  // Summarize each chunk
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const summary = await summarizer(chunk, {
      maxTokens: options?.maxSummaryTokens,
    });
    summaries.push(summary);
  }

  // Merge summaries
  const summaryContent = summaries.length === 1 ? summaries[0]! : summaries.join('\n\n---\n\n');

  // Rebuild conversation: start fresh, add summary system message, then preserved messages
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

  // Add the summary as a system message
  compacted = appendMessages(
    compacted,
    {
      role: 'system' as const,
      content: summaryContent,
      metadata: { compactionSummary: true as const },
    },
    env,
  );

  // Re-add preserved messages in order
  if (preserved.length > 0) {
    const preservedInputs: MessageInput[] = preserved.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : [...m.content],
      metadata: { ...m.metadata },
      hidden: m.hidden,
      toolCall: m.toolCall ? { ...m.toolCall } : undefined,
      toolResult: m.toolResult ? { ...m.toolResult } : undefined,
      tokenUsage: m.tokenUsage ? { ...m.tokenUsage } : undefined,
    }));
    compacted = appendMessages(compacted, ...preservedInputs, env);
  }

  return {
    conversation: compacted,
    result: {
      compacted: true,
      chunksProcessed: chunks.length,
      messagesRemoved: compactable.length,
      summaryContent,
    },
  };
}
