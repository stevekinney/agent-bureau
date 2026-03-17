import type { ConversationEnvironment } from '../environment';
import { ConversationHistory } from '../history';
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
 * Converts a ConversationHistory instance to Markdown.
 */
export function conversationHistoryToMarkdown(
  history: ConversationHistory,
  options?: ToMarkdownOptions,
): string {
  return toMarkdown(history.current, options);
}

/**
 * Creates a ConversationHistory instance from a Markdown string.
 */
export function conversationHistoryFromMarkdown(
  markdown: string,
  environment?: Partial<ConversationEnvironment>,
): ConversationHistory {
  const conversation = fromMarkdown(markdown);
  return new ConversationHistory(conversation, environment);
}
