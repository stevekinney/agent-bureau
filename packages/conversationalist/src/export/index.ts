import type { Conversation, ToMarkdownOptions } from '../types';
import { normalizeLineEndings } from '../utilities/line-endings';
import { toMarkdown } from '../utilities/markdown';

export { normalizeLineEndings } from '../utilities/line-endings';

/**
 * Exports a conversation to Markdown with normalized line endings.
 */
export function exportMarkdown(
  conversation: Conversation,
  options: ToMarkdownOptions = {},
): string {
  return normalizeLineEndings(toMarkdown(conversation, options));
}
