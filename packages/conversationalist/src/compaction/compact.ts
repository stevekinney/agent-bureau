import { assertToolReference, type ToolUseIndex } from '../conversation/tool-tracking';
import { ensureConversationSafe } from '../conversation/validation';
import type { ConversationEnvironment } from '../environment';
import { resolveConversationEnvironment, simpleTokenEstimator } from '../environment';
import type { ConversationHistory } from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';
import { buildMessageFromInput, repositionMessage } from '../utilities/message';
import { toIdRecord } from '../utilities/message-store';
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

  // The summary is minted here, not by the conversation's message plugins:
  // `result.summaryContent` is exactly what the summarizer produced, and the
  // stored summary must match it.
  const summary = buildMessageFromInput(
    {
      role: 'system' as const,
      content: summaryContent,
      metadata: { compactionSummary: true as const },
    },
    0,
    env.now(),
    env,
  );

  // Kept messages are carried over as the very messages they were: same id,
  // `createdAt`, `goalCompleted`, and content, with no second plugin pass.
  // Only `position` changes, because the kept messages now follow the summary.
  const carried = preserved.map((message, index) => repositionMessage(message, index + 1));
  const kept = [summary, ...carried];

  // Compaction never publishes a tool result without its call. Carrying
  // messages over skips the check `appendMessages` used to make, so make it
  // here: this is what rejects a `preserveToolPairs: false` window that
  // strands a result whose call was summarized.
  const toolUses: ToolUseIndex = new Map();
  for (const message of carried) {
    if (message.role === 'tool-result' && message.toolResult) {
      assertToolReference(toolUses, message.toolResult.callId);
    }
    if (message.role === 'tool-call' && message.toolCall) {
      toolUses.set(message.toolCall.id, { name: message.toolCall.name });
    }
  }

  const compacted = ensureConversationSafe(
    toReadonly({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      metadata: { ...conversation.metadata },
      ids: kept.map((message) => message.id),
      messages: toIdRecord(kept),
      createdAt: conversation.createdAt,
      updatedAt: env.now(),
    }),
  );

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
