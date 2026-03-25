import type { ConversationHistory } from './types';

/**
 * The set of possible conversation action types.
 */
export type ConversationActionType =
  | 'push'
  | 'undo'
  | 'redo'
  | 'switch'
  | 'messages.appended'
  | 'messages.updated'
  | 'messages.removed'
  | 'tool-calls.appended'
  | 'tool-results.appended'
  | 'stream.started'
  | 'stream.updated'
  | 'stream.finalized'
  | 'stream.cancelled'
  | 'compaction.started'
  | 'compaction.completed'
  | 'session.forked'
  | 'session.tagged'
  | 'session.renamed';

/**
 * Detail shape for conversation change events.
 */
export interface ConversationEventDetail {
  action: ConversationActionType;
  conversation: ConversationHistory;
  previousConversation: ConversationHistory;
  messageIds?: readonly string[];
  toolCallIds?: readonly string[];
}

/**
 * Base event class shared by all conversation events that carry the
 * standard detail payload.
 */
export class ConversationEvent extends Event {
  readonly action: ConversationActionType;
  readonly conversation: ConversationHistory;
  readonly previousConversation: ConversationHistory;
  readonly messageIds?: readonly string[] | undefined;
  readonly toolCallIds?: readonly string[] | undefined;

  constructor(type: string, detail: ConversationEventDetail) {
    super(type);
    this.action = detail.action;
    this.conversation = detail.conversation;
    this.previousConversation = detail.previousConversation;
    if (detail.messageIds !== undefined) this.messageIds = detail.messageIds;
    if (detail.toolCallIds !== undefined) this.toolCallIds = detail.toolCallIds;
  }
}

export class ConversationChangeEvent extends ConversationEvent {
  static readonly type = 'change' as const;
  constructor(detail: ConversationEventDetail) {
    super(ConversationChangeEvent.type, detail);
  }
}

export class ConversationPushEvent extends ConversationEvent {
  static readonly type = 'push' as const;
  constructor(detail: ConversationEventDetail) {
    super(ConversationPushEvent.type, detail);
  }
}

export class ConversationUndoEvent extends ConversationEvent {
  static readonly type = 'undo' as const;
  constructor(detail: ConversationEventDetail) {
    super(ConversationUndoEvent.type, detail);
  }
}

export class ConversationRedoEvent extends ConversationEvent {
  static readonly type = 'redo' as const;
  constructor(detail: ConversationEventDetail) {
    super(ConversationRedoEvent.type, detail);
  }
}

export class ConversationSwitchEvent extends ConversationEvent {
  static readonly type = 'switch' as const;
  constructor(detail: ConversationEventDetail) {
    super(ConversationSwitchEvent.type, detail);
  }
}

export class MessagesAppendedEvent extends ConversationEvent {
  static readonly type = 'messages.appended' as const;
  constructor(detail: ConversationEventDetail) {
    super(MessagesAppendedEvent.type, detail);
  }
}

export class MessagesUpdatedEvent extends ConversationEvent {
  static readonly type = 'messages.updated' as const;
  constructor(detail: ConversationEventDetail) {
    super(MessagesUpdatedEvent.type, detail);
  }
}

export class MessagesRemovedEvent extends ConversationEvent {
  static readonly type = 'messages.removed' as const;
  constructor(detail: ConversationEventDetail) {
    super(MessagesRemovedEvent.type, detail);
  }
}

export class ToolCallsAppendedEvent extends ConversationEvent {
  static readonly type = 'tool-calls.appended' as const;
  constructor(detail: ConversationEventDetail) {
    super(ToolCallsAppendedEvent.type, detail);
  }
}

export class ToolResultsAppendedEvent extends ConversationEvent {
  static readonly type = 'tool-results.appended' as const;
  constructor(detail: ConversationEventDetail) {
    super(ToolResultsAppendedEvent.type, detail);
  }
}

export class StreamStartedEvent extends ConversationEvent {
  static readonly type = 'stream.started' as const;
  constructor(detail: ConversationEventDetail) {
    super(StreamStartedEvent.type, detail);
  }
}

export class StreamUpdatedEvent extends ConversationEvent {
  static readonly type = 'stream.updated' as const;
  constructor(detail: ConversationEventDetail) {
    super(StreamUpdatedEvent.type, detail);
  }
}

export class StreamFinalizedEvent extends ConversationEvent {
  static readonly type = 'stream.finalized' as const;
  constructor(detail: ConversationEventDetail) {
    super(StreamFinalizedEvent.type, detail);
  }
}

export class StreamCancelledEvent extends ConversationEvent {
  static readonly type = 'stream.cancelled' as const;
  constructor(detail: ConversationEventDetail) {
    super(StreamCancelledEvent.type, detail);
  }
}

export class CompactionStartedEvent extends ConversationEvent {
  static readonly type = 'compaction.started' as const;
  constructor(detail: ConversationEventDetail) {
    super(CompactionStartedEvent.type, detail);
  }
}

export class CompactionCompletedEvent extends ConversationEvent {
  static readonly type = 'compaction.completed' as const;
  constructor(detail: ConversationEventDetail) {
    super(CompactionCompletedEvent.type, detail);
  }
}

export class SessionForkedEvent extends ConversationEvent {
  static readonly type = 'session.forked' as const;
  constructor(detail: ConversationEventDetail) {
    super(SessionForkedEvent.type, detail);
  }
}

export class SessionTaggedEvent extends ConversationEvent {
  static readonly type = 'session.tagged' as const;
  constructor(detail: ConversationEventDetail) {
    super(SessionTaggedEvent.type, detail);
  }
}

export class SessionRenamedEvent extends ConversationEvent {
  static readonly type = 'session.renamed' as const;
  constructor(detail: ConversationEventDetail) {
    super(SessionRenamedEvent.type, detail);
  }
}

export class PersistenceErrorEvent extends Event {
  static readonly type = 'persistence.error' as const;
  readonly error: unknown;
  constructor(error: unknown) {
    super(PersistenceErrorEvent.type);
    this.error = error;
  }
}

/**
 * Maps event type strings to their corresponding Event subclasses.
 */
export interface ConversationEventMap {
  [key: string]: Event;
  [ConversationChangeEvent.type]: ConversationChangeEvent;
  [ConversationPushEvent.type]: ConversationPushEvent;
  [ConversationUndoEvent.type]: ConversationUndoEvent;
  [ConversationRedoEvent.type]: ConversationRedoEvent;
  [ConversationSwitchEvent.type]: ConversationSwitchEvent;
  [MessagesAppendedEvent.type]: MessagesAppendedEvent;
  [MessagesUpdatedEvent.type]: MessagesUpdatedEvent;
  [MessagesRemovedEvent.type]: MessagesRemovedEvent;
  [ToolCallsAppendedEvent.type]: ToolCallsAppendedEvent;
  [ToolResultsAppendedEvent.type]: ToolResultsAppendedEvent;
  [StreamStartedEvent.type]: StreamStartedEvent;
  [StreamUpdatedEvent.type]: StreamUpdatedEvent;
  [StreamFinalizedEvent.type]: StreamFinalizedEvent;
  [StreamCancelledEvent.type]: StreamCancelledEvent;
  [CompactionStartedEvent.type]: CompactionStartedEvent;
  [CompactionCompletedEvent.type]: CompactionCompletedEvent;
  [SessionForkedEvent.type]: SessionForkedEvent;
  [SessionTaggedEvent.type]: SessionTaggedEvent;
  [SessionRenamedEvent.type]: SessionRenamedEvent;
  [PersistenceErrorEvent.type]: PersistenceErrorEvent;
}

export type ConversationEventType = Extract<keyof ConversationEventMap, string>;

/**
 * Mapping from event type strings to their constructors, used by the
 * `emitConversationEvent` helper to dispatch the correct subclass.
 */
export const conversationEventConstructors: Record<
  string,
  new (detail: ConversationEventDetail) => ConversationEvent
> = {
  [ConversationChangeEvent.type]: ConversationChangeEvent,
  [ConversationPushEvent.type]: ConversationPushEvent,
  [ConversationUndoEvent.type]: ConversationUndoEvent,
  [ConversationRedoEvent.type]: ConversationRedoEvent,
  [ConversationSwitchEvent.type]: ConversationSwitchEvent,
  [MessagesAppendedEvent.type]: MessagesAppendedEvent,
  [MessagesUpdatedEvent.type]: MessagesUpdatedEvent,
  [MessagesRemovedEvent.type]: MessagesRemovedEvent,
  [ToolCallsAppendedEvent.type]: ToolCallsAppendedEvent,
  [ToolResultsAppendedEvent.type]: ToolResultsAppendedEvent,
  [StreamStartedEvent.type]: StreamStartedEvent,
  [StreamUpdatedEvent.type]: StreamUpdatedEvent,
  [StreamFinalizedEvent.type]: StreamFinalizedEvent,
  [StreamCancelledEvent.type]: StreamCancelledEvent,
  [CompactionStartedEvent.type]: CompactionStartedEvent,
  [CompactionCompletedEvent.type]: CompactionCompletedEvent,
  [SessionForkedEvent.type]: SessionForkedEvent,
  [SessionTaggedEvent.type]: SessionTaggedEvent,
  [SessionRenamedEvent.type]: SessionRenamedEvent,
};
