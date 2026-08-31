import type { ConversationHistory, Message, MessageInput } from 'conversationalist';
import { appendMessages, createProjection } from 'conversationalist';

import type { TokenBudget } from '../../context/token-budget.ts';
import type { ContextAssembler } from '../../context/types.ts';
import type { GenerateContext } from '../types.ts';

/**
 * Converts an assembled `Message` (from `ContextAssembler`) into the
 * `MessageInput` shape `appendMessages` expects, preserving the
 * `cacheBoundary` mark a stable-prefix assembly sets on the boundary message.
 */
function toMessageInput(message: Message): MessageInput {
  const content: MessageInput['content'] =
    typeof message.content === 'string' ? message.content : [...message.content];
  return {
    role: message.role,
    content,
    metadata: { ...message.metadata },
    hidden: message.hidden,
    ...(message.toolCall ? { toolCall: message.toolCall } : {}),
    ...(message.toolResult ? { toolResult: message.toolResult } : {}),
    ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
    ...(message.cacheBoundary ? { cacheBoundary: true as const } : {}),
  };
}

/**
 * Creates a stateful helper that runs `assembler` in stable-prefix mode on
 * every call and folds the result into an incremental `ConversationHistory`
 * through `createProjection` — the same conversation-level prefix-extension
 * mechanism AB-98 built for incremental streaming projections. Reusing one
 * projection instance across calls means the unchanged stable prefix is
 * never re-processed, only the new tail; the `cacheBoundary` mark that
 * landed on the prefix's last message the first time it was appended is
 * therefore preserved untouched for as long as it stays a prefix extension.
 *
 * Shared by every provider whose caching is driven by that mark. What each
 * provider does with it differs — Anthropic lowers it to a `cache_control`
 * breakpoint on the request it was already sending, Gemini splits the
 * conversation there and creates an out-of-band `CachedContent` resource —
 * but the assembly step that produces it is identical, so it is stated once.
 */
export function createCacheAwareAssembly(
  assembler: ContextAssembler,
  budget: TokenBudget,
  pinnedMessages?: ReadonlyArray<Message>,
): (context: GenerateContext) => ConversationHistory {
  const projection = createProjection<Message>({
    identify: (message) => message.id,
    reduce: ({ conversation, event }) => appendMessages(conversation, toMessageInput(event)),
  });

  return (context: GenerateContext): ConversationHistory => {
    const { messages } = assembler({
      conversation: context.conversation,
      budget,
      stablePrefix: true,
      ...(pinnedMessages ? { pinnedMessages } : {}),
    });
    projection.apply(messages);
    return projection.snapshot();
  };
}
