import type { ConversationEnvironment } from './environment';
import type { ConversationActionType } from './events';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  updateStreamingMessage,
} from './streaming';
import type { ConversationHistory, JSONValue, Message, TokenUsage } from './types';

export type StreamingHooks = {
  readonly current: () => ConversationHistory;
  readonly environment: ConversationEnvironment;
  readonly assertOpen: () => void;
  readonly commit: (
    next: ConversationHistory,
    action: ConversationActionType,
    events: readonly ConversationActionType[],
    context?: { messageIds?: string[]; streamSequence?: number },
  ) => void;
};

export type StreamingActions = {
  readonly getStreamingMessage: () => Message | undefined;
  readonly appendStreamingMessage: (
    role: 'assistant' | 'user',
    metadata?: Record<string, JSONValue>,
  ) => string;
  readonly updateStreamingMessage: (messageId: string, content: string) => void;
  readonly finalizeStreamingMessage: (
    messageId: string,
    options?: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> },
  ) => void;
  readonly cancelStreamingMessage: (messageId: string) => void;
};

/** Owns streaming mutation sequencing while the controller owns transactions. */
export class HistoryStreaming {
  private readonly streamSequences = new Map<string, number>();

  append(
    role: 'assistant' | 'user',
    metadata: Record<string, JSONValue> | undefined,
    hooks: StreamingHooks,
  ): string {
    hooks.assertOpen();
    const result = appendStreamingMessage(hooks.current(), role, metadata, hooks.environment);
    hooks.commit(
      result.conversation,
      'stream.started',
      ['push', 'messages.appended', 'stream.started'],
      { messageIds: [result.messageId] },
    );
    return result.messageId;
  }

  update(messageId: string, content: string, hooks: StreamingHooks): void {
    hooks.assertOpen();
    const next = updateStreamingMessage(hooks.current(), messageId, content, hooks.environment);
    if (next === hooks.current()) return;
    const streamSequence = (this.streamSequences.get(messageId) ?? 0) + 1;
    this.streamSequences.set(messageId, streamSequence);
    hooks.commit(next, 'stream.updated', ['push', 'messages.updated', 'stream.updated'], {
      messageIds: [messageId],
      streamSequence,
    });
  }

  finalize(
    messageId: string,
    options: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> } | undefined,
    hooks: StreamingHooks,
  ): void {
    hooks.assertOpen();
    hooks.commit(
      finalizeStreamingMessage(hooks.current(), messageId, options, hooks.environment),
      'stream.finalized',
      ['push', 'messages.updated', 'stream.finalized'],
      { messageIds: [messageId] },
    );
  }

  cancel(messageId: string, hooks: StreamingHooks): void {
    hooks.assertOpen();
    hooks.commit(
      cancelStreamingMessage(hooks.current(), messageId, hooks.environment),
      'stream.cancelled',
      ['push', 'messages.removed', 'stream.cancelled'],
      { messageIds: [messageId] },
    );
  }
}

export function createStreamingActions(
  current: () => ConversationHistory,
  environment: ConversationEnvironment,
  assertOpen: () => void,
  commit: StreamingHooks['commit'],
): StreamingActions {
  const owner = new HistoryStreaming();
  const hooks = { current, environment, assertOpen, commit };
  return {
    getStreamingMessage: () => getStreamingMessage(current()),
    appendStreamingMessage: (role, metadata) => owner.append(role, metadata, hooks),
    updateStreamingMessage: (messageId, content) => owner.update(messageId, content, hooks),
    finalizeStreamingMessage: (messageId, options) => owner.finalize(messageId, options, hooks),
    cancelStreamingMessage: (messageId) => owner.cancel(messageId, hooks),
  };
}
