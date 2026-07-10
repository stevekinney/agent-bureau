import { appendMessages } from '../conversation/append';
import { getMessages } from '../conversation/index';
import { ensureConversationSafe } from '../conversation/validation';
import type { ConversationEnvironment } from '../environment';
import { resolveConversationEnvironment, simpleTokenEstimator } from '../environment';
import { type MultiModalContent, renderDocumentReferenceText } from '../multi-modal';
import { isStreamingMessage } from '../streaming';
import type { ConversationHistory, Message, MessageInput } from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { toReadonly } from '../utilities';

export type Summarizer = (
  messages: Message[],
  options?: { maxTokens?: number | undefined },
) => Promise<string>;

/**
 * Structured policy for which messages compaction must preserve verbatim,
 * independent of recency. Each flag defaults to `true` — compaction is
 * "safe by default" and callers opt out rather than in.
 *
 * - `pinned`: preserves any message whose `metadata.pinned === true`. Callers
 *   pin a message by setting that metadata key when appending it (e.g.
 *   `appendUserMessage(c, text, { pinned: true })`).
 * - `decisions`: preserves any message whose `metadata.decision === true`.
 *   Intended for messages recording a decision or its rationale that should
 *   survive summarization verbatim rather than being paraphrased away.
 * - `errors`: preserves tool-result messages with `toolResult.outcome ===
 *   'error'`, plus any message with `metadata.error === true`. Errors are
 *   diagnostic signal that summarization tends to flatten or drop.
 */
export interface CompactionPreservePolicy {
  pinned?: boolean | undefined;
  decisions?: boolean | undefined;
  errors?: boolean | undefined;
}

export interface CompactionOptions {
  preserveRecentCount?: number | undefined;
  preserveSystemMessages?: boolean | undefined;
  preserveToolPairs?: boolean | undefined;
  baseChunkRatio?: number | undefined;
  minimumChunkRatio?: number | undefined;
  safetyMargin?: number | undefined;
  maxSummaryTokens?: number | undefined;
  /**
   * Structured preserve policy for pinned messages, decision/error
   * annotations. Merged over the all-`true` default — set a flag to `false`
   * to opt a category back into compaction. See {@link CompactionPreservePolicy}.
   */
  preservePolicy?: CompactionPreservePolicy | undefined;
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

/**
 * Returns `true` when `message` must be preserved under the resolved
 * preserve policy, independent of its position in the conversation.
 */
function isPolicyPreservedMessage(
  message: Message,
  policy: Required<CompactionPreservePolicy>,
): boolean {
  if (policy.pinned && message.metadata['pinned'] === true) return true;
  if (policy.decisions && message.metadata['decision'] === true) return true;
  if (policy.errors) {
    if (message.toolResult?.outcome === 'error') return true;
    if (message.metadata['error'] === true) return true;
  }
  return false;
}

/**
 * Expands `selected` to include the matching tool-call/tool-result partner
 * (from `pool`) for any tool-call or tool-result message already selected,
 * so a preserved message never ends up as an orphaned half of a pair.
 */
function expandToolPairs(selected: readonly Message[], pool: readonly Message[]): Message[] {
  const toolCallById = new Map<string, Message>();
  const toolResultByCallId = new Map<string, Message>();
  for (const message of pool) {
    if (message.role === 'tool-call' && message.toolCall) {
      toolCallById.set(message.toolCall.id, message);
    }
    if (message.role === 'tool-result' && message.toolResult) {
      toolResultByCallId.set(message.toolResult.callId, message);
    }
  }

  const expanded = new Map(selected.map((m) => [m.id, m]));
  for (const message of selected) {
    if (message.role === 'tool-result' && message.toolResult) {
      const call = toolCallById.get(message.toolResult.callId);
      if (call) expanded.set(call.id, call);
    }
    if (message.role === 'tool-call' && message.toolCall) {
      const result = toolResultByCallId.get(message.toolCall.id);
      if (result) expanded.set(result.id, result);
    }
  }
  return [...expanded.values()];
}

export function partitionMessages(
  conversation: ConversationHistory,
  options?: CompactionOptions,
  _environment?: Partial<ConversationEnvironment>,
): { compactable: Message[]; preserved: Message[] } {
  const preserveRecent = options?.preserveRecentCount ?? 4;
  const preserveSystem = options?.preserveSystemMessages ?? true;
  const preserveToolPairs = options?.preserveToolPairs ?? true;
  const preservePolicy: Required<CompactionPreservePolicy> = {
    pinned: options?.preservePolicy?.pinned ?? true,
    decisions: options?.preservePolicy?.decisions ?? true,
    errors: options?.preservePolicy?.errors ?? true,
  };

  const allMessages = getMessages(conversation);

  // Separate system messages, streaming messages, and policy-preserved
  // messages (pinned / decision / error annotations) — these are preserved
  // regardless of recency.
  const systemMessages = preserveSystem ? allMessages.filter((m) => m.role === 'system') : [];
  const streamingMessages = allMessages.filter(isStreamingMessage);
  const policyPreservedMessages = allMessages.filter((m) =>
    isPolicyPreservedMessage(m, preservePolicy),
  );
  const nonSystem = allMessages.filter((m) => m.role !== 'system');

  if (nonSystem.length <= preserveRecent) {
    return { compactable: [], preserved: [...allMessages] };
  }

  // Recent N messages
  let recentMessages = nonSystem.slice(-preserveRecent);

  // If preserveToolPairs, ensure the recency window doesn't split a tool
  // pair — this one is governed by the option since it only affects which
  // messages ride along with the recent window.
  if (preserveToolPairs) {
    recentMessages = expandToolPairs(recentMessages, nonSystem);
  }

  // Streaming / policy-preserved messages (pinned, decision, error) must
  // ALWAYS keep their tool-call/tool-result partner together, regardless of
  // `preserveToolPairs`. compactConversation rebuilds the transcript by
  // re-appending `preserved` messages through `appendMessages`, which
  // rejects a tool-result whose tool-call isn't already present — orphaning
  // half of a policy-preserved pair (e.g. an error tool-result whose
  // tool-call gets compacted away) would make compaction throw.
  const alwaysPreserved: Message[] = expandToolPairs(
    [...streamingMessages, ...policyPreservedMessages],
    allMessages,
  );

  const preservedSet = new Set([
    ...systemMessages.map((m) => m.id),
    ...recentMessages.map((m) => m.id),
    ...alwaysPreserved.map((m) => m.id),
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
 * Shrinks structural tool blocks inside a content array before summarization.
 * `compactConversation` passes the result to a summarizer that may re-serialize
 * the chunk through the Anthropic adapter/API, so each block must remain a VALID
 * Anthropic block:
 * - server-tool results / server_tool_use input: the payload is replaced with a
 *   placeholder string (a result block with `content: "[tool result]"` is still
 *   well-formed).
 * - cited text: the `citations` FIELD is removed (not scalarized) — `citations`
 *   must be a structured array/object, so `"[tool result]"` would be malformed.
 * - thinking / redacted_thinking: the whole block is DROPPED — a thinking block
 *   with mutated text no longer matches its signature, and a redacted block with
 *   a placeholder in place of Anthropic's encrypted `data` is invalid, so the
 *   API would reject the summarization request. Internal reasoning need not go to
 *   the summarizer anyway.
 */
function stripStructuralToolBlocks(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') return content;
  return content.flatMap((part): MultiModalContent[] => {
    switch (part.type) {
      case 'server_tool_use':
        return [{ ...part, input: STRIPPED_PLACEHOLDER }];
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
      case 'code_execution_tool_result':
      case 'bash_code_execution_tool_result':
      case 'text_editor_code_execution_tool_result':
        return [{ ...part, content: STRIPPED_PLACEHOLDER }];
      case 'text': {
        // Drop the citations field entirely (it must be structured, not a string);
        // keep the visible text.
        if (part.citations === undefined) return [part];
        const { citations: _citations, ...rest } = part;
        return [rest];
      }
      case 'document':
        return [{ type: 'text', text: renderDocumentReferenceText(part) }];
      case 'thinking':
      case 'redacted_thinking':
        // Drop the block — a mutated thinking/redacted block is an invalid
        // Anthropic block and would break re-serialization to the API.
        return [];
      default:
        return [part];
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
