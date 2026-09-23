import { appendMessages } from '../conversation/append';
import { ensureConversationSafe } from '../conversation/validation';
import type { ConversationEnvironment } from '../environment';
import { resolveConversationEnvironment, simpleTokenEstimator } from '../environment';
import type { ConversationHistory, MessageInput } from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';
import { calculateChunkSize, chunkMessages } from './chunking';
import { partitionMessages } from './preservation';
import { stripToolResultDetails } from './stripping';
import type { CompactionOptions, CompactionResult, Summarizer } from './types';

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
      signal: options?.signal,
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
      cacheBoundary: m.cacheBoundary,
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
