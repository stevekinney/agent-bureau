import type { MultiModalContent } from '../multi-modal';
import { copyContent, renderDocumentReferenceText } from '../multi-modal';
import type { AssistantMessage, Message, MessageInput } from '../types';
import { normalizeContent } from './content';
import { toReadonly } from './type-helpers';

/**
 * The subset of a {@link ConversationEnvironment} needed to build a Message
 * from a MessageInput. Kept minimal (rather than importing the full
 * environment type) to avoid a type-only import cycle with `../environment`,
 * which itself imports from this module.
 */
export interface MessageBuildEnvironment {
  randomId: () => string;
}

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
 * Anything `buildMessageFromInput` can build from: a raw `MessageInput`, or an
 * already-built `Message`/`AssistantMessage` (e.g. the result of
 * `buildMessage`, or a message a caller received from elsewhere and wants to
 * splice into a conversation with `appendMessages`/`prependMessages`).
 */
export type AppendableMessageInput = MessageInput | Message | AssistantMessage;

/**
 * Builds a single immutable Message from an already-processed
 * MessageInput/Message: stamps `position` and, unless the input already
 * carries its own `id`/`createdAt` (i.e. it's an already-built Message being
 * re-inserted rather than raw MessageInput), assigns them via the
 * environment/batch clock. Callers are responsible for running conversation
 * plugins over the input first (if any apply) — this function only handles
 * the id/position/timestamp/shape concerns, so it can be shared by
 * `appendMessages`, `prependMessages`, and the standalone `buildMessage`
 * builder without applying plugins twice.
 *
 * Preserving a pre-existing `id`/`createdAt` matters for the primary use case
 * `buildMessage` exists for: minting a standalone Message to dispatch/persist
 * (e.g. an inbound push handler), then later adding that exact message to a
 * ConversationHistory. Without this, the stored message would silently get a
 * different id than the one already handed to the caller.
 */
export function buildMessageFromInput(
  input: AppendableMessageInput,
  position: number,
  createdAt: string,
  environment: MessageBuildEnvironment,
): Message {
  const prebuiltId = 'id' in input && typeof input.id === 'string' ? input.id : undefined;
  const prebuiltCreatedAt =
    'createdAt' in input && typeof input.createdAt === 'string' ? input.createdAt : undefined;
  const goalCompleted =
    'goalCompleted' in input && typeof input.goalCompleted === 'boolean'
      ? input.goalCompleted
      : undefined;

  // `MessageInput.content` is a mutable array; `Message.content` is a
  // ReadonlyArray. Copy rather than reuse the reference so the result always
  // satisfies the mutable shape `normalizeContent`/`createMessage` expect,
  // regardless of which shape `input` was.
  const content = typeof input.content === 'string' ? input.content : [...input.content];
  const normalizedContent = normalizeContent(content) as string | MultiModalContent[];

  const baseMessage = {
    id: prebuiltId ?? environment.randomId(),
    role: input.role,
    content: normalizedContent,
    position,
    createdAt: prebuiltCreatedAt ?? createdAt,
    metadata: { ...(input.metadata ?? {}) },
    hidden: input.hidden ?? false,
    toolCall: input.toolCall,
    toolResult: input.toolResult,
    tokenUsage: input.tokenUsage,
    cacheBoundary: input.cacheBoundary,
  };

  if (input.role === 'assistant') {
    return createMessage({
      ...baseMessage,
      role: 'assistant',
      goalCompleted,
    });
  }

  return createMessage(baseMessage);
}

/**
 * Returns a copy of a Message with its `position` updated, preserving every
 * other field — including `goalCompleted` on assistant messages. Used when
 * splicing messages into a conversation shifts the positions of the messages
 * already there (e.g. `prependMessages`, `prependSystemMessage`).
 */
export function repositionMessage(message: Message, position: number): Message {
  if (message.position === position) return message;

  const base = {
    id: message.id,
    role: message.role,
    content: message.content,
    position,
    createdAt: message.createdAt,
    metadata: { ...message.metadata },
    hidden: message.hidden,
    toolCall: message.toolCall,
    toolResult: message.toolResult,
    tokenUsage: message.tokenUsage,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    return createMessage({ ...base, role: 'assistant', goalCompleted: message.goalCompleted });
  }

  return createMessage(base);
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
