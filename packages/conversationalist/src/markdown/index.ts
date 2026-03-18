import type { ConversationEnvironment } from '../environment';
import { Conversation } from '../history';
import type { ToMarkdownOptions } from '../types';
import {
  fromMarkdown,
  getRoleFromLabel,
  getRoleLabel,
  LABEL_TO_ROLE,
  MarkdownParseError,
  ROLE_LABELS,
  toMarkdown,
} from '../utilities/markdown';

export type { ToMarkdownOptions } from '../types';

export {
  fromMarkdown,
  getRoleFromLabel,
  getRoleLabel,
  LABEL_TO_ROLE,
  MarkdownParseError,
  ROLE_LABELS,
  toMarkdown,
};

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
  const conversation = fromMarkdown(markdown);
  return new Conversation(conversation, environment);
}
