import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createInvalidPositionError } from '../errors';
import type { ConversationHistory as Conversation, Message } from '../types';
import { createMessage, toReadonly } from '../utilities';
import { redactToolResult } from '../utilities/tool-results';
import { ensureConversationSafe } from './validation';

export interface RedactMessageOptions {
  placeholder?: string;
  redactToolArguments?: boolean;
  redactToolResults?: boolean;
  clearToolMetadata?: boolean;
}

const isRedactMessageOptions = (value: unknown): value is RedactMessageOptions => {
  if (!value || typeof value !== 'object') return false;
  return (
    'placeholder' in value ||
    'redactToolArguments' in value ||
    'redactToolResults' in value ||
    'clearToolMetadata' in value
  );
};

function resolveRedactionOptions(
  placeholderOrOptions?: string | RedactMessageOptions | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): {
  placeholder: string;
  options: RedactMessageOptions;
  environment: Partial<ConversationEnvironment> | undefined;
} {
  let placeholder = '[REDACTED]';
  let options: RedactMessageOptions = {};
  let resolvedEnvironment = environment;

  if (typeof placeholderOrOptions === 'string') {
    placeholder = placeholderOrOptions;
  } else if (placeholderOrOptions) {
    if (!environment && isConversationEnvironmentParameter(placeholderOrOptions)) {
      resolvedEnvironment = placeholderOrOptions;
    } else if (isRedactMessageOptions(placeholderOrOptions)) {
      options = placeholderOrOptions;
      if (options.placeholder) {
        placeholder = options.placeholder;
      }
    }
  }

  return { placeholder, options, environment: resolvedEnvironment };
}

function redactToolCallMetadata(
  original: Message,
  options: RedactMessageOptions,
  placeholder: string,
): Message['toolCall'] {
  const toolCall = original.toolCall ? { ...original.toolCall } : undefined;
  if (original.role === 'tool-call' && toolCall && (options.redactToolArguments ?? true)) {
    return { ...toolCall, arguments: placeholder };
  }
  return toolCall;
}

function redactToolResultMetadata(
  original: Message,
  options: RedactMessageOptions,
  placeholder: string,
): Message['toolResult'] {
  const toolResult = original.toolResult ? { ...original.toolResult } : undefined;
  if (original.role === 'tool-result' && toolResult && (options.redactToolResults ?? true)) {
    return redactToolResult(toolResult, placeholder);
  }
  return toolResult;
}

/**
 * Replaces message content while preserving identity and order. Tool payloads
 * are redacted by default; an out-of-bounds position throws.
 */
export function redactMessageAtPosition(
  conversation: Conversation,
  position: number,
  placeholderOrOptions?: string | RedactMessageOptions | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolved = resolveRedactionOptions(placeholderOrOptions, environment);

  if (position < 0 || position >= conversation.ids.length) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  const id = conversation.ids[position];
  const original = id !== undefined ? conversation.messages[id] : undefined;
  if (!original) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  const redacted: Message = createMessage({
    id: original.id,
    role: original.role,
    content: resolved.placeholder,
    position: original.position,
    createdAt: original.createdAt,
    metadata: { ...original.metadata },
    hidden: original.hidden,
    toolCall: resolved.options.clearToolMetadata
      ? undefined
      : redactToolCallMetadata(original, resolved.options, resolved.placeholder),
    toolResult: resolved.options.clearToolMetadata
      ? undefined
      : redactToolResultMetadata(original, resolved.options, resolved.placeholder),
    tokenUsage: original.tokenUsage ? { ...original.tokenUsage } : undefined,
    cacheBoundary: original.cacheBoundary,
  });

  const resolvedEnvironment = resolveConversationEnvironment(resolved.environment);
  const now = resolvedEnvironment.now();
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [redacted.id]: redacted },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}
