import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { MultiModalContent } from '../../multi-modal';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  ToolResult,
} from '../../types';
import { isCanonicalToolResultPayload, parseJSONValue } from '../shared';
import type { OpenAIContentPart, OpenAIMessage, OpenAITextContentPart } from './types';

function toConversationContent(
  content: string | OpenAIContentPart[] | OpenAITextContentPart[] | null,
): MessageInput['content'] | undefined {
  if (content === null) {
    return undefined;
  }

  if (typeof content === 'string') {
    return content;
  }

  const parts: MultiModalContent[] = content.map((part: OpenAIContentPart): MultiModalContent =>
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
    inputs.push(...toMessageInput(message));
  }

  return inputs;
}

function toMessageInput(message: OpenAIMessage): MessageInput[] {
  switch (message.role) {
    case 'system':
    case 'user':
      return [
        {
          role: message.role,
          content: toConversationContent(message.content) ?? '',
        },
      ];

    case 'assistant':
      return toAssistantInputs(message);

    case 'tool':
      return [
        {
          role: 'tool-result',
          content: '',
          toolResult: parseToolResult(message.tool_call_id, message.content),
        },
      ];
    default:
      return [];
  }
}

function toAssistantInputs(message: Extract<OpenAIMessage, { role: 'assistant' }>): MessageInput[] {
  const inputs: MessageInput[] = [];
  const assistantContent = toConversationContent(message.content);
  const hasAssistantContent = assistantContent !== undefined && assistantContent.length > 0;

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

  return inputs;
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
