/**
 * Anthropic-shaped types with no dependency on `@anthropic-ai/sdk`.
 *
 * Kept separate from `./index` so that `history.ts` (and therefore the
 * package root and `./conversation` entry points) can reference
 * {@link AnthropicConversation} without pulling the optional
 * `@anthropic-ai/sdk` peer dependency into their declaration closure.
 */

/**
 * Anthropic text content block.
 */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  /** Citation references on cited text (e.g. web-search results); preserved opaquely. */
  citations?: unknown;
}

/**
 * Anthropic image content block.
 */
export interface AnthropicBase64ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface AnthropicUrlImageSource {
  type: 'url';
  url: string;
}

export type AnthropicImageSource = AnthropicBase64ImageSource | AnthropicUrlImageSource;

export interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

export interface AnthropicBase64DocumentSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface AnthropicTextDocumentSource {
  type: 'text';
  media_type: string;
  data: string;
}

export interface AnthropicUrlDocumentSource {
  type: 'url';
  url: string;
}

export interface AnthropicFileDocumentSource {
  type: 'file';
  file_id: string;
}

export type AnthropicDocumentSource =
  | AnthropicBase64DocumentSource
  | AnthropicTextDocumentSource
  | AnthropicUrlDocumentSource
  | AnthropicFileDocumentSource;

export interface AnthropicDocumentBlock {
  type: 'document';
  source: AnthropicDocumentSource;
  title?: string;
}

/**
 * Anthropic tool use content block.
 */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/**
 * Anthropic tool result content block.
 */
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Anthropic extended thinking content block.
 * The signature must be preserved byte-for-byte for subsequent conversation turns.
 */
export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Anthropic redacted extended thinking content block.
 * The thinking text is omitted; only the signature is present to verify integrity.
 * The signature must be preserved byte-for-byte for subsequent conversation turns.
 */
export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Anthropic server-tool use content block (e.g. built-in tools like web_search).
 * Input accumulates via input_json_delta during streaming.
 */
export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: unknown;
}

/**
 * Anthropic web search tool result content block returned by the built-in web_search tool.
 */
export interface AnthropicWebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: unknown;
}

/**
 * Anthropic server-tool result block — code execution (`code_execution`,
 * `bash_code_execution`, `text_editor_code_execution`) and web fetch each emit
 * their own `*_tool_result` block. Enumerated explicitly so they round-trip
 * instead of being dropped; add a literal when Anthropic ships a new one.
 */
export interface AnthropicServerToolResultBlock {
  type:
    | 'code_execution_tool_result'
    | 'bash_code_execution_tool_result'
    | 'text_editor_code_execution_tool_result'
    | 'web_fetch_tool_result';
  tool_use_id: string;
  content: unknown;
}

/**
 * Anthropic container upload block — references a file uploaded into a
 * code-execution container by id.
 */
export interface AnthropicContainerUploadBlock {
  type: 'container_upload';
  file_id: string;
}

/**
 * Anthropic prompt-cache breakpoint marker. Attached to the LAST content
 * block of a message (or system block) to mark everything up to and
 * including it as a cacheable stable prefix. Lowered from
 * {@link import('../../types').MessageInput.cacheBoundary}.
 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
  /**
   * Cache breakpoint lifetime. Anthropic defaults to a 5-minute TTL when
   * omitted; `'1h'` opts into the extended one-hour cache
   * (see https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration).
   */
  ttl?: '5m' | '1h';
}

/**
 * Anthropic content block union type. Every block variant can carry a
 * `cache_control` breakpoint marker.
 */
export type AnthropicContentBlock = (
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock
  | AnthropicServerToolResultBlock
  | AnthropicContainerUploadBlock
) & { cache_control?: AnthropicCacheControl };

/**
 * Anthropic message format for the Messages API.
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * A system-prompt block, mirroring the shape Anthropic accepts when `system`
 * is passed as an array of blocks rather than a single string (required to
 * attach a `cache_control` breakpoint to an individual system segment).
 */
export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

/**
 * Result of converting a conversation to Anthropic format.
 * System messages are extracted separately since Anthropic uses a top-level
 * system parameter. `system` is a plain string unless at least one system
 * message carries a cache boundary, in which case each system message
 * becomes its own addressable block so the breakpoint can be attached.
 */
export interface AnthropicConversation {
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
}
