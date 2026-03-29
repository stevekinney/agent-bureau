/**
 * Subagent context isolation.
 *
 * Provides helpers to prepare an isolated conversation for a subagent
 * (inheriting parent system messages and recent context) and to merge
 * the subagent's result back into the parent conversation.
 */

import type { Conversation, JSONValue, Message } from 'conversationalist';
import { Conversation as ConversationClass } from 'conversationalist';

/** Options for preparing a subagent's conversation context. */
export interface PrepareSubagentContextOptions {
  /** Instructions injected as a system message in the child conversation. */
  instructions: string;
  /**
   * Number of recent non-system parent messages to include as context.
   * Default: `2`.
   */
  recentParentMessageCount?: number;
}

/** Options for merging a subagent result back into the parent. */
export interface MergeSubagentResultOptions {
  /** The text content produced by the subagent. */
  content: string;
  /** Name of the subagent, stored in metadata for provenance tracking. */
  agentName?: string;
}

/**
 * Creates a new, isolated `Conversation` for a subagent.
 *
 * The child conversation inherits:
 * - All system messages from the parent.
 * - A summary of the most recent parent messages (controlled by
 *   `recentParentMessageCount`).
 * - The subagent's own instructions injected as a system message.
 *
 * Mutations to the child conversation do not affect the parent.
 */
export function prepareSubagentContext(
  parentConversation: Conversation,
  options: PrepareSubagentContextOptions,
): Conversation {
  const { instructions, recentParentMessageCount = 2 } = options;

  const child = new ConversationClass();
  const parentMessages = parentConversation.getMessages();

  // Copy system messages from parent
  const systemMessages = parentMessages.filter((m: Message) => m.role === 'system');
  for (const msg of systemMessages) {
    child.appendSystemMessage(typeof msg.content === 'string' ? msg.content : '');
  }

  // Inject subagent instructions
  child.appendSystemMessage(instructions);

  // Include recent parent context
  const nonSystem = parentMessages.filter((m: Message) => m.role !== 'system');
  const recentMessages = nonSystem.slice(-recentParentMessageCount);

  for (const msg of recentMessages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (msg.role === 'user') {
      child.appendUserMessage(content);
    } else if (msg.role === 'assistant') {
      child.appendAssistantMessage(content);
    }
    // Tool calls and results are not copied to subagent context
  }

  return child;
}

/**
 * Merges a subagent's result into the parent conversation as an assistant
 * message with metadata indicating the source agent.
 */
export function mergeSubagentResult(
  parentConversation: Conversation,
  options: MergeSubagentResultOptions,
): void {
  const { content, agentName } = options;

  const metadata: Record<string, JSONValue> = {
    subagentResult: true,
  };

  if (agentName) {
    metadata['subagentName'] = agentName;
  }

  parentConversation.appendAssistantMessage(content, metadata);
}
