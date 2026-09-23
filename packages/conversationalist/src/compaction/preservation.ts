import { getMessages } from '../conversation/index';
import type { ConversationEnvironment } from '../environment';
import { isStreamingMessage } from '../streaming';
import type { ConversationHistory, Message } from '../types';
import type { CompactionOptions, CompactionPreservePolicy } from './types';

function isPolicyPreservedMessage(
  message: Message,
  policy: Required<CompactionPreservePolicy>,
): boolean {
  const metadata = message.metadata;
  return Boolean(
    (policy.pinned && metadata['pinned'] === true) ||
    (policy.decisions && metadata['decision'] === true) ||
    (policy.errors && (message.toolResult?.outcome === 'error' || metadata['error'] === true)),
  );
}

function partnerForMessage(
  message: Message,
  calls: Map<string, Message>,
  results: Map<string, Message>,
) {
  if (message.role === 'tool-result' && message.toolResult)
    return calls.get(message.toolResult.callId);
  if (message.role === 'tool-call' && message.toolCall) return results.get(message.toolCall.id);
  return undefined;
}

function expandToolPairs(selected: readonly Message[], pool: readonly Message[]): Message[] {
  const calls = new Map<string, Message>();
  const results = new Map<string, Message>();
  for (const message of pool) {
    if (message.role === 'tool-call' && message.toolCall) calls.set(message.toolCall.id, message);
    if (message.role === 'tool-result' && message.toolResult)
      results.set(message.toolResult.callId, message);
  }
  const expanded = new Map(selected.map((message) => [message.id, message]));
  for (const message of selected) {
    const partner = partnerForMessage(message, calls, results);
    if (partner) expanded.set(partner.id, partner);
  }
  return [...expanded.values()];
}

function resolvePolicy(options?: CompactionOptions): Required<CompactionPreservePolicy> {
  return {
    pinned: options?.preservePolicy?.pinned ?? true,
    decisions: options?.preservePolicy?.decisions ?? true,
    errors: options?.preservePolicy?.errors ?? true,
  };
}

function selectRecentMessages(messages: Message[], count: number): Message[] {
  return count === 0 ? [] : messages.slice(-count);
}

export function partitionMessages(
  conversation: ConversationHistory,
  options?: CompactionOptions,
  _environment?: Partial<ConversationEnvironment>,
): { compactable: Message[]; preserved: Message[] } {
  const preserveRecent = options?.preserveRecentCount ?? 4;
  const preserveSystem = options?.preserveSystemMessages ?? true;
  const preserveToolPairs = options?.preserveToolPairs ?? true;
  const preservePolicy = resolvePolicy(options);

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
  let recentMessages = selectRecentMessages(nonSystem, preserveRecent);

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
