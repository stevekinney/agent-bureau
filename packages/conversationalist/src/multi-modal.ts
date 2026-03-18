export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  url: string;
  mimeType?: string;
  text?: string;
}

export type MultiModalContent = TextContent | ImageContent;

/**
 * Creates a shallow copy of a MultiModalContent item.
 */
export function copyMultiModalContent(item: MultiModalContent): MultiModalContent {
  if (item.type === 'text') {
    return {
      type: 'text',
      text: item.text,
    };
  }
  return {
    type: 'image',
    url: item.url,
    ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
    ...(item.text !== undefined ? { text: item.text } : {}),
  };
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
