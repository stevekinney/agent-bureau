import { appendMessages, createConversationHistory } from '../../conversation/index';
import { assertConversationSafe } from '../../conversation/validation';
import { type MultiModalContent, renderDocumentReferenceText } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  Message,
  MessageInput,
  ToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import { isCanonicalToolResultPayload, parseJSONValue, toJSONValue } from '../shared';

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

/**
 * Anthropic's documented limit on explicit `cache_control` breakpoints per
 * request — a request with more than this many marked blocks is rejected.
 * See https://platform.claude.com/docs/en/build-with-claude/prompt-caching.
 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Anthropic cannot cache a `thinking`/`redacted_thinking` block (the
 * signature covers the whole block, so marking it is meaningless) or a text
 * block with no content (there is nothing to cache).
 */
function isCacheableAnthropicBlock(block: AnthropicContentBlock): boolean {
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
  if (block.type === 'text' && block.text === '') return false;
  return true;
}

/**
 * Finds the last block in a run that Anthropic can actually attach
 * `cache_control` to, walking backward from the end. Returns -1 if none of
 * the blocks are cacheable.
 */
function lastCacheableBlockIndex(blocks: ReadonlyArray<AnthropicContentBlock>): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (isCacheableAnthropicBlock(blocks[index]!)) return index;
  }
  return -1;
}

function stripCacheControl<T extends { cache_control?: AnthropicCacheControl }>(block: T): T {
  if (block.cache_control === undefined) return block;
  const { cache_control: _cacheControl, ...rest } = block;
  return rest as T;
}

/**
 * Enforces Anthropic's 4-breakpoint-per-request cap. When more than 4 blocks
 * carry `cache_control`, strips it from the EARLIEST excess ones and keeps
 * only the last {@link MAX_CACHE_BREAKPOINTS} in document order (system
 * blocks first, then messages in order). Anthropic's caching is
 * prefix-cumulative, so a later breakpoint still covers everything an
 * earlier, now-unmarked one would have — dropping the oldest marks loses
 * their own distinct cache-hit granularity, not their coverage.
 */
function capCacheBreakpoints(result: AnthropicConversation): AnthropicConversation {
  type Location =
    | { kind: 'system'; index: number }
    | { kind: 'message'; messageIndex: number; blockIndex: number };

  const locations: Location[] = [];

  if (Array.isArray(result.system)) {
    result.system.forEach((block, index) => {
      if (block.cache_control !== undefined) locations.push({ kind: 'system', index });
    });
  }

  result.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.cache_control !== undefined) {
        locations.push({ kind: 'message', messageIndex, blockIndex });
      }
    });
  });

  if (locations.length <= MAX_CACHE_BREAKPOINTS) return result;

  const toStrip = locations.slice(0, locations.length - MAX_CACHE_BREAKPOINTS);
  const stripSystemIndices = new Set(
    toStrip
      .filter(
        (location): location is Extract<Location, { kind: 'system' }> => location.kind === 'system',
      )
      .map((location) => location.index),
  );
  const stripMessageBlocks = new Map<number, Set<number>>();
  for (const location of toStrip) {
    if (location.kind === 'message') {
      const set = stripMessageBlocks.get(location.messageIndex) ?? new Set<number>();
      set.add(location.blockIndex);
      stripMessageBlocks.set(location.messageIndex, set);
    }
  }

  const system = Array.isArray(result.system)
    ? result.system.map((block, index) =>
        stripSystemIndices.has(index) ? stripCacheControl(block) : block,
      )
    : result.system;

  const messages = result.messages.map((message, messageIndex) => {
    const blockIndicesToStrip = stripMessageBlocks.get(messageIndex);
    if (!blockIndicesToStrip || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block, blockIndex) =>
        blockIndicesToStrip.has(blockIndex) ? stripCacheControl(block) : block,
      ),
    };
  });

  const capped: AnthropicConversation = { messages };
  if (system !== undefined) {
    capped.system = system;
  }
  return capped;
}

/**
 * Converts internal multi-modal content to Anthropic content blocks.
 */
function toAnthropicContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return content;
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({
          type: 'text',
          text: part.text ?? '',
          ...(part.citations !== undefined ? { citations: part.citations } : {}),
        });
        break;
      case 'thinking':
        // Preserve thinking blocks byte-for-byte (signature is integrity-critical)
        blocks.push({ type: 'thinking', thinking: part.thinking, signature: part.signature });
        break;
      case 'redacted_thinking':
        // Preserve redacted_thinking blocks byte-for-byte (the encrypted `data` is integrity-critical)
        blocks.push({ type: 'redacted_thinking', data: part.data });
        break;
      case 'server_tool_use':
        blocks.push({ type: 'server_tool_use', id: part.id, name: part.name, input: part.input });
        break;
      case 'web_search_tool_result':
        blocks.push({
          type: 'web_search_tool_result',
          tool_use_id: part.tool_use_id,
          content: part.content,
        });
        break;
      case 'code_execution_tool_result':
      case 'bash_code_execution_tool_result':
      case 'text_editor_code_execution_tool_result':
      case 'web_fetch_tool_result':
        blocks.push({
          type: part.type,
          tool_use_id: part.tool_use_id,
          content: part.content,
        });
        break;
      case 'container_upload':
        blocks.push({ type: 'container_upload', file_id: part.file_id });
        break;
      case 'document':
        if (part.source.kind === 'base64') {
          blocks.push({
            type: 'document',
            title: part.name,
            source: {
              type: 'base64',
              media_type: part.mimeType,
              data: part.source.data,
            },
          });
        } else if (
          part.source.uri.startsWith('http://') ||
          part.source.uri.startsWith('https://')
        ) {
          blocks.push({
            type: 'document',
            title: part.name,
            source: {
              type: 'url',
              url: part.source.uri,
            },
          });
        } else if (part.source.uri.startsWith('file:')) {
          blocks.push({
            type: 'document',
            title: part.name,
            source: {
              type: 'file',
              file_id: part.source.uri.slice('file:'.length),
            },
          });
        } else {
          blocks.push({ type: 'text', text: renderDocumentReferenceText(part) });
        }
        break;
      case 'image': {
        // Anthropic supports both URL and base64. A `data:` URL that matches the
        // base64 shape becomes a base64 source; anything else (including a `data:`
        // URL that does not match — e.g. non-base64-encoded) falls through to a
        // url source rather than being silently dropped from the payload.
        const url = part.url ?? '';
        const base64Match = url.startsWith('data:')
          ? url.match(/^data:([^;]+);base64,(.+)$/)
          : null;
        if (base64Match && base64Match[1] && base64Match[2]) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: base64Match[1],
              data: base64Match[2],
            },
          });
        } else {
          blocks.push({
            type: 'image',
            source: {
              type: 'url',
              url,
            },
          });
        }
        break;
      }
    }
  }

  // Collapse a lone plain text block to a string — but NOT one carrying
  // citations, which would be lost in the string form.
  const only = blocks.length === 1 ? blocks[0] : undefined;
  return only?.type === 'text' && only.citations === undefined ? only.text : blocks;
}

/**
 * Converts an internal ToolCall to Anthropic tool_use block.
 */
function toToolUseBlock(toolCall: ToolCall): AnthropicToolUseBlock {
  let input: unknown = toolCall.arguments;
  if (typeof toolCall.arguments === 'string') {
    try {
      input = JSON.parse(toolCall.arguments) as unknown;
    } catch {
      input = toolCall.arguments;
    }
  }
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input,
  };
}

/**
 * Converts an internal ToolResult to Anthropic tool_result block.
 */
function toToolResultBlock(toolResult: ToolResult): AnthropicToolResultBlock {
  const payload =
    toolResult.outcome === 'success'
      ? toolResult.content
      : {
          outcome: toolResult.outcome,
          content: toolResult.content,
          ...(toolResult.error ? { error: toolResult.error } : {}),
          ...(toolResult.action ? { action: toolResult.action } : {}),
        };
  const result: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };

  if (toolResult.outcome !== 'success') {
    result.is_error = true;
  }

  return result;
}

/**
 * Renders a single system/developer message's content to plain text.
 */
function systemMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

/**
 * Collects system message content from a conversation. Returns a plain
 * joined string in the common case; when at least one system message carries
 * a `cacheBoundary`, returns one addressable block per system message so the
 * cache breakpoint can be attached to the right segment.
 */
function extractSystemPrompt(
  messages: ReadonlyArray<Message>,
): string | AnthropicSystemBlock[] | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const hasCacheBoundary = systemMessages.some((m) => m.cacheBoundary);
  if (!hasCacheBoundary) {
    return systemMessages.map((m) => systemMessageText(m)).join('\n\n');
  }

  return systemMessages.map((m) => {
    const text = systemMessageText(m);
    // Anthropic cannot cache an empty text block — there is nothing to cache.
    const canCache = m.cacheBoundary && text !== '';
    return {
      type: 'text' as const,
      text,
      ...(canCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
  });
}

/**
 * Converts a conversation to Anthropic Messages API format.
 * System messages are extracted to the top-level `system` field.
 * Tool calls become tool_use blocks, tool results become tool_result blocks.
 *
 * @example
 * ```ts
 * import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
 *
 * const { system, messages } = toAnthropicMessages(conversation);
 * const response = await anthropic.messages.create({
 *   model: 'claude-3-opus-20240229',
 *   system,
 *   messages,
 * });
 * ```
 */
export function toAnthropicMessages(conversation: Conversation): AnthropicConversation {
  assertConversationSafe(conversation);
  const ordered = getOrderedMessages(conversation);
  const system = extractSystemPrompt(ordered);
  const messages: AnthropicMessage[] = [];

  // Track pending content blocks to merge consecutive same-role messages
  let currentRole: 'user' | 'assistant' | null = null;
  let currentBlocks: AnthropicContentBlock[] = [];

  const flushCurrent = () => {
    if (currentRole && currentBlocks.length > 0) {
      const onlyBlock = currentBlocks.length === 1 ? currentBlocks[0] : undefined;
      // A cache_control breakpoint must stay attached to a real block — a
      // lone text block carrying one cannot collapse to a bare string.
      const collapsible =
        onlyBlock?.type === 'text' &&
        onlyBlock.citations === undefined &&
        onlyBlock.cache_control === undefined;
      messages.push({
        role: currentRole,
        content: collapsible && onlyBlock?.type === 'text' ? onlyBlock.text : currentBlocks,
      });
      currentBlocks = [];
    }
    currentRole = null;
  };

  for (const message of ordered) {
    if (message.hidden) continue;
    if (isStreamingMessage(message)) continue;

    // Skip system messages (already extracted)
    if (message.role === 'system' || message.role === 'developer') {
      continue;
    }

    // Skip snapshots
    if (message.role === 'snapshot') {
      continue;
    }

    let targetRole: 'user' | 'assistant';
    let blocks: AnthropicContentBlock[];

    if (message.role === 'user') {
      targetRole = 'user';
      const content = toAnthropicContent(message.content);
      if (typeof content === 'string') {
        blocks = [{ type: 'text', text: content }];
      } else {
        blocks = content;
      }
    } else if (message.role === 'assistant') {
      targetRole = 'assistant';
      const content = toAnthropicContent(message.content);
      if (typeof content === 'string') {
        blocks = [{ type: 'text', text: content }];
      } else {
        blocks = content;
      }
    } else if (message.role === 'tool-call' && message.toolCall) {
      targetRole = 'assistant';
      blocks = [toToolUseBlock(message.toolCall)];
    } else if (message.role === 'tool-result' && message.toolResult) {
      targetRole = 'user';
      blocks = [toToolResultBlock(message.toolResult)];
    } else {
      continue;
    }

    // A cache boundary marks everything up to and including THIS message as
    // cacheable, so the breakpoint lands on the last block this specific
    // message contributed (not the last block of the merged Anthropic
    // message, which may span several ConversationHistory messages). Anthropic
    // cannot cache a `thinking`/`redacted_thinking` block or an empty text
    // block, so walk backward to the last block that CAN carry the mark;
    // if none exists, the boundary is silently not lowered for this message
    // rather than producing an invalid breakpoint.
    if (message.cacheBoundary && blocks.length > 0) {
      const index = lastCacheableBlockIndex(blocks);
      if (index !== -1) {
        const target = blocks[index]!;
        blocks = [
          ...blocks.slice(0, index),
          { ...target, cache_control: { type: 'ephemeral' } },
          ...blocks.slice(index + 1),
        ];
      }
    }

    // Merge with current or start new
    if (currentRole === targetRole) {
      currentBlocks.push(...blocks);
    } else {
      flushCurrent();
      currentRole = targetRole;
      currentBlocks = blocks;
    }
  }

  flushCurrent();

  const result: AnthropicConversation = { messages };
  if (system !== undefined) {
    result.system = system;
  }
  return capCacheBreakpoints(result);
}

function parseToolResultContent(callId: string, content: string, isError?: boolean): ToolResult {
  const parsed = parseJSONValue(content);

  if (parsed !== undefined && isCanonicalToolResultPayload(parsed)) {
    return {
      callId,
      outcome: parsed.outcome,
      content: parsed.content,
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.action ? { action: parsed.action } : {}),
      ...(typeof parsed.inputDigest === 'string' ? { inputDigest: parsed.inputDigest } : {}),
      ...(typeof parsed.outputDigest === 'string' ? { outputDigest: parsed.outputDigest } : {}),
    };
  }

  return {
    callId,
    outcome: isError ? 'error' : 'success',
    content: parsed ?? content,
  };
}

/**
 * Maps the role-bearing Anthropic blocks — `tool_use` and `tool_result` — to
 * their dedicated conversation messages. Groupable content blocks are handled by
 * {@link toGroupableContentPart}; only `tool_use`/`tool_result` reach here.
 */
function toMessageInputFromBlock(
  block: AnthropicToolUseBlock | AnthropicToolResultBlock,
): MessageInput {
  if (block.type === 'tool_use') {
    return {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: block.id,
        name: block.name,
        arguments: toJSONValue(block.input),
      },
    };
  }

  return {
    role: 'tool-result',
    content: '',
    toolResult: parseToolResultContent(block.tool_use_id, block.content, block.is_error),
  };
}

/**
 * Maps an Anthropic content block that can coexist with siblings inside a single
 * message to its {@link MultiModalContent} part, preserving fields byte-for-byte.
 * Returns `undefined` for blocks that must become their own message because the
 * conversation model represents them as distinct roles (`tool_use` →
 * `tool-call`, `tool_result` → `tool-result`).
 */
function toGroupableContentPart(block: AnthropicContentBlock): MultiModalContent | undefined {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.citations !== undefined ? { citations: toJSONValue(block.citations) } : {}),
      };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: toJSONValue(block.input),
      };
    case 'web_search_tool_result':
      return {
        type: 'web_search_tool_result',
        tool_use_id: block.tool_use_id,
        content: toJSONValue(block.content),
      };
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'web_fetch_tool_result':
      // Preserve server-tool results (code execution, web fetch) instead of dropping them.
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        content: toJSONValue(block.content),
      };
    case 'container_upload':
      // Preserve the uploaded-file reference instead of dropping it.
      return { type: 'container_upload', file_id: block.file_id };
    case 'document': {
      const name = block.title ?? 'document';
      if (block.source.type === 'base64') {
        return {
          type: 'document',
          name,
          mimeType: block.source.media_type,
          source: { kind: 'base64', data: block.source.data },
        };
      }
      if (block.source.type === 'text') {
        return { type: 'text', text: block.source.data };
      }
      if (block.source.type === 'url') {
        return {
          type: 'document',
          name,
          mimeType: 'application/octet-stream',
          source: { kind: 'reference', uri: block.source.url },
        };
      }
      return {
        type: 'document',
        name,
        mimeType: 'application/octet-stream',
        source: { kind: 'reference', uri: `file:${block.source.file_id}` },
      };
    }
    case 'image':
      return block.source.type === 'url'
        ? { type: 'image', url: block.source.url }
        : {
            type: 'image',
            url: `data:${block.source.media_type};base64,${block.source.data}`,
            mimeType: block.source.media_type,
          };
    default:
      // tool_use / tool_result are role-bearing and handled separately.
      return undefined;
  }
}

function toMessageInputs(payload: AnthropicConversation): MessageInput[] {
  const inputs: MessageInput[] = [];

  if (typeof payload.system === 'string') {
    inputs.push({
      role: 'system',
      content: payload.system,
    });
  } else if (payload.system !== undefined) {
    // Array form: one addressable system segment per block, cache mark
    // restored from `cache_control` on that block.
    for (const block of payload.system) {
      inputs.push({
        role: 'system',
        content: block.text,
        ...(block.cache_control !== undefined ? { cacheBoundary: true } : {}),
      });
    }
  }

  for (const message of payload.messages) {
    if (typeof message.content === 'string') {
      inputs.push({
        role: message.role,
        content: message.content,
      });
      continue;
    }

    // Preserve the original Anthropic block order. Groupable blocks (text,
    // thinking, redacted_thinking, image, server_tool_use, web_search_tool_result)
    // accumulate into a single ordered multi-part MessageInput. Role-bearing
    // blocks (tool_use → tool-call, tool_result → tool-result) are distinct
    // messages in the conversation model, so they flush the current run and emit
    // their own message, keeping interleaved sequences like
    // [text, tool_use, text] in their true order.
    let pendingParts: MultiModalContent[] = [];
    let pendingCacheBoundary = false;

    const flushPending = () => {
      if (pendingParts.length === 0) return;
      const cacheBoundaryFlag = pendingCacheBoundary ? { cacheBoundary: true as const } : {};
      // A lone PLAIN text part round-trips as a string to match the
      // one-block-one-string storage convention; a cited text part (or any mixed
      // run) stays as an array so citations aren't lost.
      const first = pendingParts[0];
      if (pendingParts.length === 1 && first?.type === 'text' && first.citations === undefined) {
        inputs.push({ role: message.role, content: first.text, ...cacheBoundaryFlag });
      } else {
        inputs.push({ role: message.role, content: pendingParts, ...cacheBoundaryFlag });
      }
      pendingParts = [];
      pendingCacheBoundary = false;
    };

    for (const block of message.content) {
      const part = toGroupableContentPart(block);
      if (part !== undefined) {
        if (block.cache_control !== undefined) {
          // `cache_control` marks "everything up to and including THIS
          // block" as the stable prefix — and ONLY this block, since encode
          // attaches it to the last block a specific ConversationHistory
          // message contributed. Flush whatever preceded it as its own
          // (un-marked) message first, then this block as its own
          // boundary-marked message, so a later block in the same Anthropic
          // message (possible after `toAnthropicMessages` merges
          // consecutive same-role messages) neither absorbs the boundary
          // nor gets folded into it.
          flushPending();
          pendingParts.push(part);
          pendingCacheBoundary = true;
          flushPending();
        } else {
          pendingParts.push(part);
        }
      } else if (block.type === 'tool_use' || block.type === 'tool_result') {
        // Role-bearing block: flush the accumulated run first to preserve order.
        flushPending();
        const roleInput = toMessageInputFromBlock(block);
        inputs.push(
          block.cache_control !== undefined ? { ...roleInput, cacheBoundary: true } : roleInput,
        );
      }
    }

    flushPending();
  }

  return inputs;
}

/**
 * Converts Anthropic Messages API payloads back into a ConversationHistory.
 */
export function fromAnthropicMessages(payload: AnthropicConversation): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(payload);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendAnthropicMessages(
  conversation: Conversation,
  payload: AnthropicConversation,
): Conversation {
  const inputs = toMessageInputs(payload);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}

export const anthropicConversationAdapter = {
  export(conversation: Conversation): AnthropicConversation {
    return toAnthropicMessages(conversation);
  },
  import(payload: AnthropicConversation): Conversation {
    return fromAnthropicMessages(payload);
  },
  append(conversation: Conversation, payload: AnthropicConversation): Conversation {
    return appendAnthropicMessages(conversation, payload);
  },
} as const;
