import type { MultiModalContent } from '@lasercat/homogenaize';

/**
 * Converts content to a multi-modal array format.
 * Wraps strings in a text content object, normalizes single items to arrays.
 */
export function toMultiModalArray(
  input: string | MultiModalContent | MultiModalContent[],
): MultiModalContent[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return Array.isArray(input) ? input : [input];
}

/**
 * Normalizes content to either a string or multi-modal array.
 * Single MultiModalContent items are wrapped in an array.
 */
export function normalizeContent(
  content?: string | MultiModalContent | MultiModalContent[],
): string | MultiModalContent[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content : [content];
}
