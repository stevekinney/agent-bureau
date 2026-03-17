import type { MultiModalContent } from '@lasercat/homogenaize';

import { assertConversationSafe } from '../../conversation/validation';
import type { Conversation, Message, ToolCall, ToolResult } from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';

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
 * Anthropic content block union type.
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

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
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'image') {
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
  const result: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content:
      typeof toolResult.content === 'string'
        ? toolResult.content
        : JSON.stringify(toolResult.content),
  };

  if (toolResult.outcome === 'error') {
    result.is_error = true;
  }

  return result;
}

/**
 * Collects system message content from a conversation.
 */
function extractSystemContent(messages: ReadonlyArray<Message>): string | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden,
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
 * import { toAnthropicMessages } from 'conversationalist/anthropic';
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

    // Skip system messages (already extracted)
    if (message.role === 'system' || message.role === 'developer') {
      continue;
    }

    // Skip snapshots
    if (message.role === 'snapshot') {
      continue;
    }

    let targetRole: 'user' | 'assistant';
    let blocks: AnthropicContentBlock[] = [];

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
    } else if (message.role === 'tool-use' && message.toolCall) {
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
