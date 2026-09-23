import { truncateFromPosition } from './context-recent';
import { rewindBeforeMessage, rewindBeforePosition, type RewindOptions } from './context-rewind';
import { truncateToTokenLimit, type TruncateOptions } from './context-truncation';
import type { RedactMessageOptions } from './conversation/index';
import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  collapseSystemMessages,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
} from './conversation/index';
import type { ConversationEnvironment } from './environment';
import type { ConversationChangeContext } from './history-events';
import type { ConversationHistory, JSONValue, MessageInput } from './types';

type MutationHooks = {
  readonly current: () => ConversationHistory;
  readonly environment: ConversationEnvironment;
  readonly assertOpen: () => void;
  readonly createChangeContext: (
    previous: ConversationHistory,
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
  ) => ConversationChangeContext;
  readonly pushWithEvents: (
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
    context?: ConversationChangeContext,
  ) => void;
};

export type MutationActions = {
  readonly appendMessages: (...inputs: MessageInput[]) => void;
  readonly appendUserMessage: (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ) => void;
  readonly appendAssistantMessage: (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ) => void;
  readonly appendSystemMessage: (content: string, metadata?: Record<string, JSONValue>) => void;
  readonly prependSystemMessage: (content: string, metadata?: Record<string, JSONValue>) => void;
  readonly replaceSystemMessage: (content: string, metadata?: Record<string, JSONValue>) => void;
  readonly collapseSystemMessages: () => void;
  readonly redactMessageAtPosition: (
    position: number,
    options?: string | RedactMessageOptions,
  ) => void;
  readonly truncateFromPosition: (position: number, options?: TruncateOptions) => void;
  readonly rewindBeforePosition: (position: number, options?: RewindOptions) => void;
  readonly rewindBeforeMessage: (messageId: string, options?: RewindOptions) => void;
  readonly truncateToTokenLimit: (maxTokens: number, options?: TruncateOptions) => void;
};

export function createMutationActions(hooks: MutationHooks): MutationActions {
  const push = (
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
  ): void => {
    const previous = hooks.current();
    hooks.pushWithEvents(next, action, hooks.createChangeContext(previous, next, action));
  };
  const append = (...inputs: MessageInput[]): void => {
    hooks.assertOpen();
    push(appendMessages(hooks.current(), ...inputs, hooks.environment), 'messages.appended');
  };
  const appendUser = (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void => {
    hooks.assertOpen();
    push(
      appendUserMessage(hooks.current(), content, metadata, hooks.environment),
      'messages.appended',
    );
  };
  const appendAssistant = (
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void => {
    hooks.assertOpen();
    push(
      appendAssistantMessage(hooks.current(), content, metadata, hooks.environment),
      'messages.appended',
    );
  };
  const appendSystem = (content: string, metadata?: Record<string, JSONValue>): void => {
    hooks.assertOpen();
    push(
      appendSystemMessage(hooks.current(), content, metadata, hooks.environment),
      'messages.appended',
    );
  };
  const prependSystem = (content: string, metadata?: Record<string, JSONValue>): void => {
    hooks.assertOpen();
    push(
      prependSystemMessage(hooks.current(), content, metadata, hooks.environment),
      'messages.appended',
    );
  };
  const replaceSystem = (content: string, metadata?: Record<string, JSONValue>): void => {
    hooks.assertOpen();
    push(
      replaceSystemMessage(hooks.current(), content, metadata, hooks.environment),
      'messages.updated',
    );
  };
  const collapseSystem = (): void => {
    hooks.assertOpen();
    const previous = hooks.current();
    const next = collapseSystemMessages(previous, hooks.environment);
    push(next, previous.ids.length === next.ids.length ? 'messages.updated' : 'messages.removed');
  };
  const redact = (position: number, options?: string | RedactMessageOptions): void => {
    hooks.assertOpen();
    push(
      redactMessageAtPosition(hooks.current(), position, options, hooks.environment),
      'messages.updated',
    );
  };
  const truncate = (position: number, options?: TruncateOptions): void => {
    hooks.assertOpen();
    push(
      truncateFromPosition(hooks.current(), position, options, hooks.environment),
      'messages.removed',
    );
  };
  const rewindPosition = (position: number, options?: RewindOptions): void => {
    hooks.assertOpen();
    const previous = hooks.current();
    const next = rewindBeforePosition(previous, position, options, hooks.environment);
    if (next !== previous) push(next, 'messages.removed');
  };
  const rewindMessage = (messageId: string, options?: RewindOptions): void => {
    hooks.assertOpen();
    const previous = hooks.current();
    const next = rewindBeforeMessage(previous, messageId, options, hooks.environment);
    if (next !== previous) push(next, 'messages.removed');
  };
  const truncateTokens = (maxTokens: number, options?: TruncateOptions): void => {
    hooks.assertOpen();
    push(
      truncateToTokenLimit(hooks.current(), maxTokens, options, hooks.environment),
      'messages.removed',
    );
  };
  return {
    appendMessages: append,
    appendUserMessage: appendUser,
    appendAssistantMessage: appendAssistant,
    appendSystemMessage: appendSystem,
    prependSystemMessage: prependSystem,
    replaceSystemMessage: replaceSystem,
    collapseSystemMessages: collapseSystem,
    redactMessageAtPosition: redact,
    truncateFromPosition: truncate,
    rewindBeforePosition: rewindPosition,
    rewindBeforeMessage: rewindMessage,
    truncateToTokenLimit: truncateTokens,
  };
}
