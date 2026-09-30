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

  // Hidden messages are not model-visible, so the recency window and the
  // summarizer never see them. They are not disposable either: every hidden
  // message is kept, so nothing leaves history without being summarized.
  const everyMessage = getMessages(conversation, { includeHidden: true });
  const hiddenMessages = everyMessage.filter((m) => m.hidden);
  const allMessages = everyMessage.filter((m) => !m.hidden);

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
    return { compactable: [], preserved: [...everyMessage] };
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
  // carrying `preserved` messages over, and the rebuilt history is validated:
  // a tool-result whose tool-call isn't present is rejected. Orphaning half
  // of a preserved pair (e.g. an error tool-result whose tool-call gets
  // compacted away, or a hidden call whose visible result is kept) would make
  // compaction throw. Hidden messages ride along the same way.
  const alwaysPreserved: Message[] = expandToolPairs(
    [...streamingMessages, ...policyPreservedMessages, ...hiddenMessages],
    everyMessage,
  );

  const preservedSet = new Set([
    ...systemMessages.map((m) => m.id),
    ...recentMessages.map((m) => m.id),
    ...alwaysPreserved.map((m) => m.id),
  ]);
  const compactable = everyMessage.filter((m) => !preservedSet.has(m.id));
  const preserved = everyMessage.filter((m) => preservedSet.has(m.id));

  return { compactable, preserved };
}
