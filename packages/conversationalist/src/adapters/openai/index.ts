import { appendMessages, createConversationHistory } from '../../conversation/index';
import { assertConversationSafe } from '../../conversation/validation';
import { type MultiModalContent, renderDocumentReferenceText } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  MessageInput,
  ToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import { isCanonicalToolResultPayload, parseJSONValue } from '../shared';

export interface OpenAIConversationExportOptions {
  groupToolCalls?: boolean;
}

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
    } else if (part.type === 'document') {
      parts.push({ type: 'text', text: renderDocumentReferenceText(part) });
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
  return toOpenAIContent(content, { allowImages: false }) as string | OpenAITextContentPart[];
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

function toConversationContent(
  content: string | OpenAIContentPart[] | OpenAITextContentPart[] | null,
): MessageInput['content'] | undefined {
  if (content === null) {
    return undefined;
  }

  if (typeof content === 'string') {
    return content;
  }

  const parts: MultiModalContent[] = content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', url: part.image_url.url },
  );

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text ?? '';
  }

  return parts;
}

function parseToolArguments(value: string): JSONValue {
  return parseJSONValue(value) ?? value;
}

function parseToolResult(callId: string, content: string | OpenAITextContentPart[]): ToolResult {
  const serialized =
    typeof content === 'string' ? content : content.map((part) => part.text).join('\n\n');
  const parsed = parseJSONValue(serialized);

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
    outcome: 'success',
    content: parsed ?? serialized,
  };
}

function toMessageInputs(messages: ReadonlyArray<OpenAIMessage>): MessageInput[] {
  const inputs: MessageInput[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        inputs.push({
          role: 'system',
          content: toConversationContent(message.content) ?? '',
        });
        break;

      case 'user':
        inputs.push({
          role: 'user',
          content: toConversationContent(message.content) ?? '',
        });
        break;

      case 'assistant': {
        const assistantContent = toConversationContent(message.content);
        const hasAssistantContent =
          assistantContent !== undefined &&
          (typeof assistantContent === 'string'
            ? assistantContent.length > 0
            : assistantContent.length > 0);

        if (hasAssistantContent) {
          inputs.push({
            role: 'assistant',
            content: assistantContent,
          });
        }

        for (const toolCall of message.tool_calls ?? []) {
          inputs.push({
            role: 'tool-call',
            content: '',
            toolCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: parseToolArguments(toolCall.function.arguments),
            },
          });
        }
        break;
      }

      case 'tool':
        inputs.push({
          role: 'tool-result',
          content: '',
          toolResult: parseToolResult(message.tool_call_id, message.content),
        });
        break;
    }
  }

  return inputs;
}

/**
 * Converts a conversation to OpenAI Chat Completions API message format.
 * Handles role mapping, tool calls, and multi-modal content.
 *
 * @example
 * ```ts
 * import { toOpenAIMessages } from 'conversationalist/adapters/openai';
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

/**
 * Converts OpenAI Chat Completions API messages back into a ConversationHistory.
 */
export function fromOpenAIMessages(messages: ReadonlyArray<OpenAIMessage>): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(messages);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendOpenAIMessages(
  conversation: Conversation,
  messages: ReadonlyArray<OpenAIMessage>,
): Conversation {
  const inputs = toMessageInputs(messages);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}

export const openAIConversationAdapter = {
  export(
    conversation: Conversation,
    options: OpenAIConversationExportOptions = {},
  ): OpenAIMessage[] {
    return options.groupToolCalls === false
      ? toOpenAIMessages(conversation)
      : toOpenAIMessagesGrouped(conversation);
  },
  import(messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return fromOpenAIMessages(messages);
  },
  append(conversation: Conversation, messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return appendOpenAIMessages(conversation, messages);
  },
} as const;
