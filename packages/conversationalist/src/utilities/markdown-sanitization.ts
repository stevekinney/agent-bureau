import type { MultiModalContent } from '../multi-modal';
import { copyContent } from '../multi-modal';
import type {
  AssistantMessage,
  ConversationHistory as Conversation,
  Message,
  ToMarkdownOptions,
} from '../types';
import { isAssistantMessage } from './message';
import { getOrderedMessages, toIdRecord } from './message-store';
import { copyToolResult, redactToolResult } from './tool-results';
import { stripTransientFromRecord } from './transient';
import { toReadonly } from './type-helpers';

/** Placeholder used when redacting sensitive data */
const DEFAULT_REDACTED_PLACEHOLDER = '[REDACTED]';

export type ResolvedMarkdownOptions = Required<
  Pick<
    ToMarkdownOptions,
    | 'includeMetadata'
    | 'stripTransient'
    | 'includeHidden'
    | 'redactHiddenContent'
    | 'redactToolArguments'
    | 'redactToolResults'
    | 'redactedPlaceholder'
  >
>;

export function resolveMarkdownOptions(options: ToMarkdownOptions = {}): ResolvedMarkdownOptions {
  return {
    includeMetadata: options.includeMetadata ?? false,
    stripTransient: options.stripTransient ?? false,
    includeHidden: options.includeHidden ?? true,
    redactHiddenContent: options.redactHiddenContent ?? false,
    redactToolArguments: options.redactToolArguments ?? false,
    redactToolResults: options.redactToolResults ?? false,
    redactedPlaceholder: options.redactedPlaceholder ?? DEFAULT_REDACTED_PLACEHOLDER,
  };
}

/**
 * Replaces the payloads of structural tool blocks inside a content array with
 * the placeholder, mirroring the role-level redaction options:
 * - `redactArguments` masks server-tool INPUT (a tool argument, e.g. a web-search
 *   query), gated like role-level `redactToolArguments`.
 * - `redactResults` masks server-tool RESULT content (web search/fetch, code
 *   execution) and citation metadata on text parts (tool-result evidence),
 *   gated like role-level `redactToolResults`.
 */
function redactStructuralToolBlocks(
  content: string | MultiModalContent[],
  placeholder: string,
  redactArguments: boolean,
  redactResults: boolean,
): string | MultiModalContent[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'server_tool_use') {
      return redactArguments ? { ...part, input: placeholder } : part;
    }
    if ('tool_use_id' in part) {
      return redactResults ? { ...part, content: placeholder } : part;
    }
    if (part.type === 'text' && redactResults && part.citations !== undefined) {
      const { citations: _citations, ...rest } = part;
      return rest;
    }
    return part;
  });
}

function sanitizeContent(message: Message, options: ResolvedMarkdownOptions) {
  if (options.redactHiddenContent && message.hidden) return options.redactedPlaceholder;
  const content = copyContent(message.content);
  if (!options.redactToolArguments && !options.redactToolResults) return content;
  return redactStructuralToolBlocks(
    content,
    options.redactedPlaceholder,
    options.redactToolArguments,
    options.redactToolResults,
  );
}

function sanitizeMessage(message: Message, options: ResolvedMarkdownOptions): Message {
  const metadata = options.stripTransient
    ? stripTransientFromRecord({ ...message.metadata })
    : { ...message.metadata };

  const content = sanitizeContent(message, options);

  const toolCall = message.toolCall
    ? {
        ...message.toolCall,
        arguments: options.redactToolArguments
          ? options.redactedPlaceholder
          : message.toolCall.arguments,
      }
    : undefined;

  const toolResult = message.toolResult
    ? options.redactToolResults
      ? redactToolResult(message.toolResult, options.redactedPlaceholder)
      : copyToolResult(message.toolResult)
    : undefined;

  const baseMessage = {
    id: message.id,
    role: message.role,
    content,
    position: message.position,
    createdAt: message.createdAt,
    metadata: toReadonly(metadata),
    hidden: message.hidden,
    toolCall: toolCall ? toReadonly(toolCall) : undefined,
    toolResult: toolResult ? toReadonly(toolResult) : undefined,
    tokenUsage: message.tokenUsage ? toReadonly({ ...message.tokenUsage }) : undefined,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    const assistantMessage: AssistantMessage = {
      ...baseMessage,
      role: 'assistant',
      goalCompleted: message.goalCompleted,
    };
    return assistantMessage;
  }

  return baseMessage;
}

export function prepareConversationForMarkdown(
  conversation: Conversation,
  options: ResolvedMarkdownOptions,
): Conversation {
  const metadata = options.stripTransient
    ? stripTransientFromRecord({ ...conversation.metadata })
    : { ...conversation.metadata };

  const messages = getOrderedMessages(conversation)
    .filter((message) => options.includeHidden || !message.hidden)
    .map((message) => sanitizeMessage(message, options));

  return {
    schemaVersion: conversation.schemaVersion,
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    metadata: toReadonly(metadata),
    ids: toReadonly(messages.map((message) => message.id)),
    messages: toReadonly(toIdRecord(messages)),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
