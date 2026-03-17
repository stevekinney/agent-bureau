import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createInvalidPositionError } from '../errors';
import type { Conversation, Message } from '../types';
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
  const candidate = value as Record<string, unknown>;
  return (
    'placeholder' in candidate ||
    'redactToolArguments' in candidate ||
    'redactToolResults' in candidate ||
    'clearToolMetadata' in candidate
  );
};

/**
 * Replaces the content of a message at the specified position with a placeholder.
 * By default preserves tool identifiers/outcomes while redacting tool payloads.
 * Throws if the position is out of bounds.
 */
export function redactMessageAtPosition(
  conversation: Conversation,
  position: number,
  placeholderOrOptions?: string | RedactMessageOptions | Partial<ConversationEnvironment>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  let placeholder = '[REDACTED]';
  let options: RedactMessageOptions = {};
  let env = environment;

  if (typeof placeholderOrOptions === 'string') {
    placeholder = placeholderOrOptions;
  } else if (placeholderOrOptions) {
    if (!environment && isConversationEnvironmentParameter(placeholderOrOptions)) {
      env = placeholderOrOptions;
    } else if (isRedactMessageOptions(placeholderOrOptions)) {
      options = placeholderOrOptions;
      if (options.placeholder) {
        placeholder = options.placeholder;
      }
    }
  }

  const redactToolArguments = options.redactToolArguments ?? true;
  const redactToolResults = options.redactToolResults ?? true;
  const clearToolMetadata = options.clearToolMetadata ?? false;

  if (position < 0 || position >= conversation.ids.length) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  const id = conversation.ids[position];
  const original = id ? conversation.messages[id] : undefined;
  if (!original) {
    throw createInvalidPositionError(conversation.ids.length - 1, position);
  }

  let toolCall = original.toolCall ? { ...original.toolCall } : undefined;
  let toolResult = original.toolResult ? { ...original.toolResult } : undefined;

  if (clearToolMetadata) {
    toolCall = undefined;
    toolResult = undefined;
  } else {
    if (original.role === 'tool-use' && toolCall) {
      toolCall = {
        ...toolCall,
        arguments: redactToolArguments ? placeholder : toolCall.arguments,
      };
    }

    if (original.role === 'tool-result' && toolResult) {
      toolResult = redactToolResults
        ? redactToolResult(toolResult, placeholder)
        : { ...toolResult };
    }
  }

  const redacted: Message = createMessage({
    id: original.id,
    role: original.role,
    content: placeholder,
    position: original.position,
    createdAt: original.createdAt,
    metadata: { ...original.metadata },
    hidden: original.hidden,
    toolCall,
    toolResult,
    tokenUsage: original.tokenUsage ? { ...original.tokenUsage } : undefined,
  });

  const resolvedEnvironment = resolveConversationEnvironment(env);
  const now = resolvedEnvironment.now();
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [redacted.id]: redacted },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}
