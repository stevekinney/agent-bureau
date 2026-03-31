/**
 * Cache key generation strategies for LLM response caching.
 *
 * Two built-in strategies are provided:
 * - `conversationHashKey`: hashes all messages and tool names — the most thorough deduplication.
 * - `lastMessageKey`: hashes only the last user message and system prompt — useful when earlier
 *   history doesn't meaningfully affect the response.
 */

import { sha256HexSync } from 'interoperability';

import type { GenerateContext } from '../types';

/**
 * Generates a cache key by hashing the full conversation content
 * and sorted tool names.
 */
export function conversationHashKey(context: GenerateContext): string {
  const messages = context.conversation.getMessages();
  const parts: string[] = [];

  for (const message of messages) {
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    parts.push(`${message.role}:${content}`);
  }

  const toolNames = context.toolbox
    .tools()
    .map((tool) => tool.name)
    .sort();

  parts.push(`tools:${toolNames.join(',')}`);

  return sha256HexSync(parts.join('\n'));
}

/**
 * Generates a cache key by hashing only the last user message
 * and the system prompt. Ignores conversation history prefix,
 * making it suitable for stateless query-response caching.
 */
export function lastMessageKey(context: GenerateContext): string {
  const messages = context.conversation.getMessages();
  const parts: string[] = [];

  // Find the system prompt (first system message)
  const systemMessage = messages.find((m) => m.role === 'system');
  if (systemMessage) {
    const content =
      typeof systemMessage.content === 'string'
        ? systemMessage.content
        : JSON.stringify(systemMessage.content);
    parts.push(`system:${content}`);
  }

  // Find the last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];
  if (lastUser) {
    const content =
      typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
    parts.push(`user:${content}`);
  }

  return sha256HexSync(parts.join('\n'));
}
