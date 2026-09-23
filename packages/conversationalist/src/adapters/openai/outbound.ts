import { assertConversationSafe } from '../../conversation/validation';
import type { MultiModalContent } from '../../multi-modal';
import { renderDocumentReferenceText } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  Message,
  ToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITextContentPart,
  OpenAIToolCall,
} from './types';

/**
 * Converts internal multi-modal content to OpenAI content parts format.
 */
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
    const converted = toOpenAIContentPart(part, allowImages);
    if (converted) {
      parts.push(converted);
    }
  }

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return parts;
}

function toOpenAIContentPart(
  part: MultiModalContent,
  allowImages: boolean,
): OpenAIContentPart | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text ?? '' };
    case 'document':
      return { type: 'text', text: renderDocumentReferenceText(part) };
    case 'image':
      return allowImages ? { type: 'image_url', image_url: { url: part.url ?? '' } } : undefined;
    default:
      return undefined;
  }
}

/**
 * Converts internal multi-modal content to OpenAI text-only format.
 */
function toOpenAITextContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | OpenAITextContentPart[] {
  const converted = toOpenAIContent(content, { allowImages: false });
  if (typeof converted === 'string') return converted;
  return converted.map((part) => {
    if (part.type !== 'text') throw new Error('OpenAI text conversion produced an image part');
    return part;
  });
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
 *
 * `message.cacheBoundary` is intentionally a no-op here: OpenAI's prompt
 * caching (Chat Completions / Responses API) is automatic — the platform
 * caches the longest matching prefix of a request with no manual breakpoint
 * marker to translate to. There is no OpenAI wire field this maps to.
 */
function convertMessage(message: Message): OpenAIMessage | null {
  // Skip hidden messages
  if (message.hidden) {
    return null;
  }

  // Skip streaming messages (incomplete, not ready for provider export)
  if (isStreamingMessage(message)) {
    return null;
  }

  return convertMessageByRole(message);
}

function convertMessageByRole(message: Message): OpenAIMessage | null {
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

    case 'tool-call':
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
    default:
      return null;
  }
}

/**
 * Converts a tool result to a string for OpenAI.
 */
function stringifyToolResult(result: ToolResult): string {
  const payload =
    result.outcome === 'success'
      ? result.content
      : {
          outcome: result.outcome,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
          ...(result.action ? { action: result.action } : {}),
        };

  if (typeof payload === 'string') {
    return payload;
  }
  return JSON.stringify(payload);
}

/**
 * Converts a conversation to OpenAI Chat Completions API message format.
 * Handles role mapping, tool calls, and multi-modal content.
 *
 * @example
 * ```ts
 * import { toOpenAIMessages } from 'conversationalist';
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
 * Groups consecutive tool-call messages into a single assistant message with multiple tool_calls.
 * This is useful when the model made multiple tool calls in sequence.
 */
export function toOpenAIMessagesGrouped(conversation: Conversation): OpenAIMessage[] {
  assertConversationSafe(conversation);
  const messages: OpenAIMessage[] = [];
  let pendingToolCalls: OpenAIToolCall[] = [];

  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden) continue;
    if (isStreamingMessage(message)) continue;

    if (message.role === 'tool-call' && message.toolCall) {
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
    if (converted && message.role !== 'tool-call') {
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
