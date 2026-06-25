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

/**
 * Extended thinking content block.
 * Represents the model's internal reasoning. The signature must be preserved
 * byte-for-byte for subsequent conversation turns.
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Redacted extended thinking content block.
 * The thinking text is omitted; only the signature is present to verify integrity.
 * The signature must be preserved byte-for-byte for subsequent conversation turns.
 */
export interface RedactedThinkingContent {
  type: 'redacted_thinking';
  signature: string;
}

/**
 * Server-side tool use content block (e.g. Anthropic built-in tools such as web_search).
 * Input is the partial JSON accumulated during streaming.
 */
export interface ServerToolUseContent {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: unknown;
}

/**
 * Web search tool result content block returned by Anthropic's built-in web_search tool.
 */
export interface WebSearchToolResultContent {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: unknown;
}

export type MultiModalContent =
  | TextContent
  | ImageContent
  | ThinkingContent
  | RedactedThinkingContent
  | ServerToolUseContent
  | WebSearchToolResultContent;

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
  if (item.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: item.thinking,
      signature: item.signature,
    };
  }
  if (item.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      signature: item.signature,
    };
  }
  if (item.type === 'server_tool_use') {
    return {
      type: 'server_tool_use',
      id: item.id,
      name: item.name,
      input: item.input,
    };
  }
  if (item.type === 'web_search_tool_result') {
    return {
      type: 'web_search_tool_result',
      tool_use_id: item.tool_use_id,
      content: item.content,
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
