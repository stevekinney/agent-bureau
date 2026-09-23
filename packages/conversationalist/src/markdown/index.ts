import { type ConversationEnvironment, defaultConversationRuntime } from '../environment';
import { Conversation } from '../history';
import type { ToMarkdownOptions } from '../types';
import { toMarkdown } from '../utilities/markdown';
import { fromMarkdown } from '../utilities/markdown-parsing';

/**
 * Converts a Conversation instance to Markdown.
 */
export function conversationToMarkdown(
  conversation: Conversation,
  options?: ToMarkdownOptions,
): string {
  return toMarkdown(conversation.current, options);
}

/**
 * Creates a Conversation instance from a Markdown string.
 */
export function conversationFromMarkdown(
  markdown: string,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const conversation = fromMarkdown(markdown, environment?.runtime ?? defaultConversationRuntime);
  return new Conversation(conversation, environment);
}
