import type { MultiModalContent } from '../multi-modal';
import { copyContent, renderDocumentReferenceText } from '../multi-modal';
import type { AssistantMessage, Message } from '../types';
import { toReadonly } from './type-helpers';

/**
 * Creates an immutable Message from a JSON representation.
 * Deep copies nested objects and arrays to ensure immutability.
 */
export function createMessage(props: AssistantMessage): AssistantMessage;
export function createMessage(props: Message): Message;
export function createMessage(props: Message | AssistantMessage): Message | AssistantMessage {
  const content =
    typeof props.content === 'string'
      ? props.content
      : toReadonly(structuredClone([...props.content]));

  const message: Message = {
    id: props.id,
    role: props.role,
    content,
    position: props.position,
    createdAt: props.createdAt,
    metadata: toReadonly({ ...props.metadata }),
    hidden: props.hidden,
    toolCall: props.toolCall ? toReadonly(structuredClone(props.toolCall)) : undefined,
    toolResult: props.toolResult ? toReadonly(structuredClone(props.toolResult)) : undefined,
    tokenUsage: props.tokenUsage ? toReadonly({ ...props.tokenUsage }) : undefined,
    cacheBoundary: props.cacheBoundary,
  };

  if (isAssistantMessage(props)) {
    return toReadonly({
      ...message,
      role: 'assistant',
      goalCompleted: props.goalCompleted,
    });
  }

  return toReadonly(message);
}

/**
 * Converts an immutable Message to a mutable JSON representation.
 * Creates deep copies of all nested objects.
 */
export function messageToJSON(message: AssistantMessage): AssistantMessage;
export function messageToJSON(message: Message): Message;
export function messageToJSON(message: Message | AssistantMessage): Message | AssistantMessage {
  const base: Message = {
    id: message.id,
    role: message.role,
    content: copyContent(message.content),
    position: message.position,
    createdAt: message.createdAt,
    metadata: { ...message.metadata },
    hidden: message.hidden,
    toolCall: message.toolCall ? { ...message.toolCall } : undefined,
    toolResult: message.toolResult ? { ...message.toolResult } : undefined,
    tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : undefined,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    return {
      ...base,
      role: 'assistant',
      goalCompleted: message.goalCompleted,
    };
  }

  return base;
}

/**
 * Extracts the content parts from a message as a multi-modal array.
 * String content is converted to a single text part.
 */
export function messageParts(message: Message): ReadonlyArray<MultiModalContent> {
  if (typeof message.content === 'string') {
    return message.content ? [{ type: 'text', text: message.content } as MultiModalContent] : [];
  }
  return message.content;
}

/**
 * Extracts all text content from a message, joined by the specified separator.
 * Non-text parts are excluded from the result.
 */
export function messageText(message: Message, joiner: string = '\n\n'): string {
  if (typeof message.content === 'string') return message.content;
  return messageParts(message)
    .filter((p) => p.type === 'text')
    .map((p: MultiModalContent) => (p.type === 'text' ? p.text : ''))
    .join(joiner);
}

/**
 * Checks if a message contains any image content.
 */
export function messageHasImages(message: Message): boolean {
  return messageParts(message).some((p) => p.type === 'image');
}

/**
 * Converts a message to a human-readable plain-text representation. Text parts
 * are emitted verbatim and images as markdown image syntax.
 *
 * Non-text structural parts — `thinking`, `redacted_thinking`, `tool_use`,
 * `server_tool_use`, and `web_search_tool_result` — are **omitted entirely**
 * (not rendered as empty strings), because they carry no user-facing prose
 * (thinking is private; tool blocks are structured data). Omitting rather than
 * blanking means an interleaved message like `[text, tool_use, text]` joins to
 * `"A\n\nB"`, not `"A\n\n\n\nB"`. As a result this function is **not** a faithful
 * measure of a message's size or content presence: a message composed solely of
 * tool/thinking blocks stringifies to `''`. Do not use it for token estimation
 * or emptiness/presence checks — use the token estimators and the structured
 * parts (`messageParts`) for those.
 */
export function messageToString(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return messageParts(message)
    .map((part): string | null => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return `![${part.text ?? ''}](${part.url})`;
      if (part.type === 'document') return renderDocumentReferenceText(part);
      // Structural blocks carry no plain-text prose — drop them so they leave
      // no blank paragraphs in the joined output.
      return null;
    })
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

/**
 * Type guard for narrowing a Message to an AssistantMessage.
 */
export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant';
}
