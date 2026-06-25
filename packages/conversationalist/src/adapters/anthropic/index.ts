import { appendMessages, createConversationHistory } from '../../conversation/index';
import { assertConversationSafe } from '../../conversation/validation';
import type { MultiModalContent } from '../../multi-modal';
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
  signature: string;
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
 * Anthropic content block union type.
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock;

/**
 * Anthropic message format for the Messages API.
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * Result of converting a conversation to Anthropic format.
 * System messages are extracted separately since Anthropic uses a top-level system parameter.
 */
export interface AnthropicConversation {
  system?: string;
  messages: AnthropicMessage[];
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
        blocks.push({ type: 'text', text: part.text ?? '' });
        break;
      case 'thinking':
        // Preserve thinking blocks byte-for-byte (signature is integrity-critical)
        blocks.push({ type: 'thinking', thinking: part.thinking, signature: part.signature });
        break;
      case 'redacted_thinking':
        // Preserve redacted_thinking blocks byte-for-byte (signature is integrity-critical)
        blocks.push({ type: 'redacted_thinking', signature: part.signature });
        break;
      case 'tool_use':
        blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
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
      case 'image': {
        // Anthropic supports both URL and base64
        const url = part.url ?? '';
        if (url.startsWith('data:')) {
          // Base64 data URL
          const matches = url.match(/^data:([^;]+);base64,(.+)$/);
          if (matches && matches[1] && matches[2]) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            });
          }
        } else {
          // Regular URL
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

  return blocks.length === 1 && blocks[0]?.type === 'text' ? blocks[0].text : blocks;
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
 * Collects system message content from a conversation.
 */
function extractSystemContent(messages: ReadonlyArray<Message>): string | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const msg of systemMessages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push(part.text ?? '');
        }
      }
    }
  }

  return parts.join('\n\n');
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
  const system = extractSystemContent(ordered);
  const messages: AnthropicMessage[] = [];

  // Track pending content blocks to merge consecutive same-role messages
  let currentRole: 'user' | 'assistant' | null = null;
  let currentBlocks: AnthropicContentBlock[] = [];

  const flushCurrent = () => {
    if (currentRole && currentBlocks.length > 0) {
      messages.push({
        role: currentRole,
        content:
          currentBlocks.length === 1 && currentBlocks[0]?.type === 'text'
            ? currentBlocks[0].text
            : currentBlocks,
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
  return result;
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
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', signature: block.signature };
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

  if (payload.system !== undefined) {
    inputs.push({
      role: 'system',
      content: payload.system,
    });
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

    const flushPending = () => {
      if (pendingParts.length === 0) return;
      // A lone text part round-trips as a plain string to match the
      // one-block-one-string storage convention; mixed runs stay as arrays.
      const first = pendingParts[0];
      if (pendingParts.length === 1 && first?.type === 'text') {
        inputs.push({ role: message.role, content: first.text });
      } else {
        inputs.push({ role: message.role, content: pendingParts });
      }
      pendingParts = [];
    };

    for (const block of message.content) {
      const part = toGroupableContentPart(block);
      if (part !== undefined) {
        pendingParts.push(part);
      } else if (block.type === 'tool_use' || block.type === 'tool_result') {
        // Role-bearing block: flush the accumulated run first to preserve order.
        flushPending();
        inputs.push(toMessageInputFromBlock(block));
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
