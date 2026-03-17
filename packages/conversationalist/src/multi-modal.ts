/**
 * Re-exports multi-modal types from @lasercat/homogenaize
 */

import type { MultiModalContent } from '@lasercat/homogenaize';

export type { Message, MultiModalContent } from '@lasercat/homogenaize';

/**
 * TextContent and ImageContent are convenience types for discriminating MultiModalContent.
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * ImageContent is a convenience type for image parts in multi-modal content.
 */
export interface ImageContent {
  type: 'image';
  url: string;
  mimeType?: string;
  text?: string;
}

/**
 * Creates a shallow copy of a MultiModalContent item.
 */
export function copyMultiModalContent(item: MultiModalContent): MultiModalContent {
  if (item.type === 'text') {
    const result: MultiModalContent = { type: 'text' };
    if (item.text !== undefined) result.text = item.text;
    return result;
  }
  const result: MultiModalContent = { type: 'image' };
  if (item.url !== undefined) result.url = item.url;
  if (item.mimeType !== undefined) result.mimeType = item.mimeType;
  if (item.text !== undefined) result.text = item.text;
  return result;
}

/**
 * Copies content, ensuring a mutable array is returned for multi-modal content.
 */
export function copyContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map(copyMultiModalContent);
}
