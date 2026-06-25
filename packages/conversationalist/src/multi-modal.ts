import type { JSONValue } from './types';

export interface TextContent {
  type: 'text';
  text: string;
  /**
   * Citation references Anthropic attaches to cited text (e.g. from web search).
   * Preserved opaquely so they round-trip for display and multi-turn replay.
   */
  citations?: JSONValue;
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
 * The plaintext reasoning is withheld; Anthropic returns its encrypted payload in
 * a `data` field (NOT a `signature`). The `data` must be preserved byte-for-byte
 * and replayed unchanged on subsequent conversation turns.
 */
export interface RedactedThinkingContent {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Server-side tool use content block (e.g. Anthropic built-in tools such as web_search).
 * Input is the JSON the model produced for the built-in tool.
 *
 * Note: there is intentionally NO client-tool-use content block. A client tool
 * call is represented as a `tool-call` ROLE message (so a later `tool-result`
 * can pair to it), not as assistant content — putting a client tool call in
 * content would create an orphaned tool result that integrity rejects.
 */
export interface ServerToolUseContent {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: JSONValue;
}

/**
 * Web search tool result content block returned by Anthropic's built-in web_search tool.
 */
export interface WebSearchToolResultContent {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Result block types for Anthropic's built-in code-execution server tools.
 * Enumerated explicitly (rather than an open string) so they discriminate
 * cleanly; add a literal here when Anthropic ships a new server-tool result.
 */
export type CodeExecutionToolResultType =
  | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result'
  | 'text_editor_code_execution_tool_result';

/**
 * Result block returned by Anthropic's built-in code-execution server tools
 * (`code_execution`, `bash_code_execution`, `text_editor_code_execution`).
 * Preserves stdout, exit codes, file ids, and errors so they round-trip in the
 * conversation history instead of being dropped.
 */
export interface CodeExecutionToolResultContent {
  type: CodeExecutionToolResultType;
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Container upload content block. Anthropic represents a file uploaded into a
 * code-execution container as a `container_upload` block referencing the
 * uploaded file by id; preserved so the reference survives the round-trip.
 */
export interface ContainerUploadContent {
  type: 'container_upload';
  file_id: string;
}

export type MultiModalContent =
  | TextContent
  | ImageContent
  | ThinkingContent
  | RedactedThinkingContent
  | ServerToolUseContent
  | WebSearchToolResultContent
  | CodeExecutionToolResultContent
  | ContainerUploadContent;

/**
 * Creates a shallow copy of a MultiModalContent item.
 */
export function copyMultiModalContent(item: MultiModalContent): MultiModalContent {
  if (item.type === 'text') {
    return {
      type: 'text',
      text: item.text,
      ...(item.citations !== undefined ? { citations: structuredClone(item.citations) } : {}),
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
      data: item.data,
    };
  }
  if (item.type === 'server_tool_use') {
    return {
      type: 'server_tool_use',
      // Deep-copy the JSON payload: copyContent feeds messageToJSON and clone
      // paths that must return independent values, so a shared object/array
      // reference would let a mutation of the copy leak into the original.
      id: item.id,
      name: item.name,
      input: structuredClone(item.input),
    };
  }
  if (item.type === 'web_search_tool_result') {
    return {
      type: 'web_search_tool_result',
      tool_use_id: item.tool_use_id,
      content: structuredClone(item.content),
    };
  }
  if (
    item.type === 'code_execution_tool_result' ||
    item.type === 'bash_code_execution_tool_result' ||
    item.type === 'text_editor_code_execution_tool_result'
  ) {
    return {
      type: item.type,
      tool_use_id: item.tool_use_id,
      content: structuredClone(item.content),
    };
  }
  if (item.type === 'container_upload') {
    return { type: 'container_upload', file_id: item.file_id };
  }
  // All non-image variants are handled above. TypeScript cannot fully narrow
  // `item` to ImageContent here because CodeExecutionToolResultContent's `type`
  // is itself a union alias, so we assert the exhausted remainder.
  const image = item as ImageContent;
  return {
    type: 'image',
    url: image.url,
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
    ...(image.text !== undefined ? { text: image.text } : {}),
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
