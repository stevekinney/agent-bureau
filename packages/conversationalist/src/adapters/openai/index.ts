import type { MultiModalContent } from '@lasercat/homogenaize';

import { assertConversationSafe } from '../../conversation/validation';
import type { Conversation, Message, ToolCall, ToolResult } from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';

/**
 * OpenAI text content part.
 */
export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

/**
 * OpenAI image content part.
 */
export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * OpenAI content part union type.
 */
export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/**
 * OpenAI tool call format.
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI system message format for the Chat Completions API.
 */
export interface OpenAISystemMessage {
  role: 'system';
  content: string | OpenAITextContentPart[];
  name?: string;
}

/**
 * OpenAI user message format for the Chat Completions API.
 */
export interface OpenAIUserMessage {
  role: 'user';
  content: string | OpenAIContentPart[];
  name?: string;
}

/**
 * OpenAI assistant message format for the Chat Completions API.
 */
export interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | OpenAITextContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
}

/**
 * OpenAI tool message format for the Chat Completions API.
 */
export interface OpenAIToolMessage {
  role: 'tool';
  content: string | OpenAITextContentPart[];
  tool_call_id: string;
}

/**
 * OpenAI message format for the Chat Completions API.
 */
export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

/**
 * Converts internal multi-modal content to OpenAI content parts format.
 */
function toOpenAIContent(
  content: string | ReadonlyArray<MultiModalContent>,
  options: { allowImages: false },
): string | OpenAITextContentPart[];
function toOpenAIContent(
  content: string | ReadonlyArray<MultiModalContent>,
  options?: { allowImages?: true },
): string | OpenAIContentPart[];
function toOpenAIContent(
  content: string | ReadonlyArray<MultiModalContent>,
  options: { allowImages?: boolean } = {},
): string | OpenAIContentPart[] | OpenAITextContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const allowImages = options.allowImages ?? true;
  const parts: OpenAIContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'image' && allowImages) {
      parts.push({
        type: 'image_url',
        image_url: { url: part.url ?? '' },
      });
    }
  }

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return allowImages ? parts : (parts as OpenAITextContentPart[]);
}

/**
 * Converts internal multi-modal content to OpenAI text-only format.
 */
function toOpenAITextContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | OpenAITextContentPart[] {
  return toOpenAIContent(content, { allowImages: false });
}

/**
 * Converts an internal ToolCall to OpenAI format.
 */
function toOpenAIToolCall(toolCall: ToolCall): OpenAIToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments:
        typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments),
    },
  };
}

/**
 * Converts a single message to OpenAI format.
 * Returns null for messages that should be skipped.
 */
function convertMessage(message: Message): OpenAIMessage | null {
  // Skip hidden messages
  if (message.hidden) {
    return null;
  }

  switch (message.role) {
    case 'system':
    case 'developer':
      return {
        role: 'system',
        content: toOpenAITextContent(message.content),
      };

    case 'user':
      return {
        role: 'user',
        content: toOpenAIContent(message.content),
      };

    case 'assistant':
      return {
        role: 'assistant',
        content: toOpenAITextContent(message.content),
      };

    case 'tool-use':
      if (!message.toolCall) {
        return null;
      }
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toOpenAIToolCall(message.toolCall)],
      };

    case 'tool-result':
      if (!message.toolResult) {
        return null;
      }
      return {
        role: 'tool',
        content: stringifyToolResult(message.toolResult),
        tool_call_id: message.toolResult.callId,
      };

    case 'snapshot':
      // Snapshots are internal state, not sent to API
      return null;
  }
}

/**
 * Converts a tool result to a string for OpenAI.
 */
function stringifyToolResult(result: ToolResult): string {
  if (typeof result.content === 'string') {
    return result.content;
  }
  return JSON.stringify(result.content);
}

/**
 * Converts a conversation to OpenAI Chat Completions API message format.
 * Handles role mapping, tool calls, and multi-modal content.
 *
 * @example
 * ```ts
 * import { toOpenAIMessages } from 'conversationalist/openai';
 *
 * const messages = toOpenAIMessages(conversation);
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4',
 *   messages,
 * });
 * ```
 */
export function toOpenAIMessages(conversation: Conversation): OpenAIMessage[] {
  assertConversationSafe(conversation);
  const messages: OpenAIMessage[] = [];

  for (const message of getOrderedMessages(conversation)) {
    const converted = convertMessage(message);
    if (converted) {
      messages.push(converted);
    }
  }

  return messages;
}

/**
 * Groups consecutive tool-use messages into a single assistant message with multiple tool_calls.
 * This is useful when the model made multiple tool calls in sequence.
 */
export function toOpenAIMessagesGrouped(conversation: Conversation): OpenAIMessage[] {
  assertConversationSafe(conversation);
  const messages: OpenAIMessage[] = [];
  let pendingToolCalls: OpenAIToolCall[] = [];

  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden) continue;

    if (message.role === 'tool-use' && message.toolCall) {
      pendingToolCalls.push(toOpenAIToolCall(message.toolCall));
      continue;
    }

    // Flush pending tool calls before adding a new message
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }

    const converted = convertMessage(message);
    if (converted && message.role !== 'tool-use') {
      messages.push(converted);
    }
  }

  // Flush any remaining tool calls
  if (pendingToolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls,
    });
  }

  return messages;
}
