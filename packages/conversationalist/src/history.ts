import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
  EventListenerLike,
  EventListenerOptionsLike,
} from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import type { AnthropicConversation } from './adapters/anthropic';
import type { GeminiConversation } from './adapters/gemini';
import type { OpenAIMessage } from './adapters/openai';

import {
  estimateConversationTokens,
  getRecentMessages,
  truncateFromPosition,
  type TruncateOptions,
  truncateToTokenLimit,
} from './context';
import type { RedactMessageOptions } from './conversation/index';
import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  appendUserMessage,
  collapseSystemMessages,
  createConversationHistory,
  deserializeConversationHistory,
  getFirstSystemMessage,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getPendingToolCalls,
  getStatistics,
  getSystemMessages,
  getToolInteractions,
  hasSystemMessage,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
  searchConversationMessages,
  toChatMessages,
} from './conversation/index';
import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  resolveConversationEnvironment,
} from './environment';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  updateStreamingMessage,
} from './streaming';
import type {
  ConversationHistory,
  ConversationProvider,
  ConversationNodeSnapshot,
  ConversationSnapshot,
  JSONValue,
  Message,
  MessageInput,
  TokenUsage,
  AppendableToolCallInput,
  AppendableToolResult,
} from './types';
import type { ToolInteraction } from './conversation/index';

/**
 * Event detail for conversation changes.
 */
export interface ConversationEventDetail {
  action: ConversationActionType;
  conversation: ConversationHistory;
  previousConversation: ConversationHistory;
  messageIds?: readonly string[];
  toolCallIds?: readonly string[];
}

export type ConversationEvent = EmissionEvent<
  ConversationEventDetail,
  ConversationEventType
>;

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
  | 'stream.cancelled';

export interface ConversationEvents {
  change: ConversationEventDetail;
  push: ConversationEventDetail;
  undo: ConversationEventDetail;
  redo: ConversationEventDetail;
  switch: ConversationEventDetail;
  'messages.appended': ConversationEventDetail;
  'messages.updated': ConversationEventDetail;
  'messages.removed': ConversationEventDetail;
  'tool-calls.appended': ConversationEventDetail;
  'tool-results.appended': ConversationEventDetail;
  'stream.started': ConversationEventDetail;
  'stream.updated': ConversationEventDetail;
  'stream.finalized': ConversationEventDetail;
  'stream.cancelled': ConversationEventDetail;
}

export type ConversationEventType = Extract<keyof ConversationEvents, string>;

interface HistoryNode {
  conversation: ConversationHistory;
  parent: HistoryNode | null;
  children: HistoryNode[];
}

type ConversationAdapter = {
  export: (conversation: ConversationHistory, options?: any) => unknown;
  import: (payload: any) => ConversationHistory;
  append: (conversation: ConversationHistory, payload: any) => ConversationHistory;
};

type ConversationChangeContext = {
  messageIds?: string[];
  toolCallIds?: string[];
};

function diffConversationMessages(
  previousConversation: ConversationHistory,
  nextConversation: ConversationHistory,
): {
  appended: string[];
  updated: string[];
  removed: string[];
} {
  const previousIds = new Set(previousConversation.ids);
  const nextIds = new Set(nextConversation.ids);
  const appended = nextConversation.ids.filter((id) => !previousIds.has(id));
  const removed = previousConversation.ids.filter((id) => !nextIds.has(id));
  const updated: string[] = [];

  for (const id of nextConversation.ids) {
    if (!previousIds.has(id)) {
      continue;
    }
    const previousMessage = previousConversation.messages[id];
    const nextMessage = nextConversation.messages[id];
    if (!previousMessage || !nextMessage) {
      continue;
    }
    if (JSON.stringify(previousMessage) !== JSON.stringify(nextMessage)) {
      updated.push(id);
    }
  }

  return { appended, updated, removed };
}

function collectToolCallIds(
  conversation: ConversationHistory,
  messageIds?: readonly string[],
): string[] | undefined {
  if (!messageIds || messageIds.length === 0) {
    return undefined;
  }

  const ids = new Set<string>();
  for (const messageId of messageIds) {
    const message = conversation.messages[messageId];
    if (!message) {
      continue;
    }
    if (message.toolCall?.id) {
      ids.add(message.toolCall.id);
    }
    if (message.toolResult?.callId) {
      ids.add(message.toolResult.callId);
    }
  }

  return ids.size > 0 ? [...ids] : undefined;
}

async function loadConversationAdapter(
  provider: ConversationProvider,
): Promise<ConversationAdapter> {
  switch (provider) {
    case 'openai': {
      const module = await import('./adapters/openai');
      return module.openAIConversationAdapter;
    }
    case 'anthropic': {
      const module = await import('./adapters/anthropic');
      return module.anthropicConversationAdapter;
    }
    case 'gemini': {
      const module = await import('./adapters/gemini');
      return module.geminiConversationAdapter;
    }
  }
}

/**
 * Manages a stack of conversation versions to support undo, redo, and branching.
 */
export class Conversation extends EventTarget {
  private currentNode: HistoryNode;
  private environment: ConversationEnvironment;
  private readonly eventHub = createEventTarget<ConversationEvents>();

  constructor(
    initial: ConversationHistory = createConversationHistory(),
    environment?: Partial<ConversationEnvironment>,
  ) {
    super();
    this.environment = resolveConversationEnvironment(environment);
    const safeInitial = ensureConversationSafe(initial);
    this.currentNode = {
      conversation: safeInitial,
      parent: null,
      children: [],
    };
  }

  private buildEventDetail(
    action: ConversationActionType,
    previousConversation: ConversationHistory,
    context: ConversationChangeContext = {},
  ): ConversationEventDetail {
    return {
      action,
      conversation: this.current,
      previousConversation,
      ...(context.messageIds && context.messageIds.length > 0
        ? { messageIds: context.messageIds }
        : {}),
      ...(context.toolCallIds && context.toolCallIds.length > 0
        ? { toolCallIds: context.toolCallIds }
        : {}),
    };
  }

  private emitConversationEvent(
    type: ConversationEventType,
    detail: ConversationEventDetail,
  ): void {
    this.eventHub.dispatchEvent({ type, detail });
  }

  private commit(
    next: ConversationHistory,
    changeAction: ConversationActionType,
    emittedEvents: readonly ConversationEventType[],
    context?: ConversationChangeContext,
  ): void {
    const previousConversation = this.current;
    const newNode: HistoryNode = {
      conversation: next,
      parent: this.currentNode,
      children: [],
    };
    this.currentNode.children.push(newNode);
    this.currentNode = newNode;

    this.emitConversationEvent(
      'change',
      this.buildEventDetail(changeAction, previousConversation, context),
    );

    for (const eventType of emittedEvents) {
      if (eventType === 'change') {
        continue;
      }
      const eventAction = eventType as ConversationActionType;
      this.emitConversationEvent(
        eventType,
        this.buildEventDetail(eventAction, previousConversation, context),
      );
    }
  }

  private toAddListenerOptions(
    options?: boolean | AddEventListenerOptions,
  ): AddEventListenerOptionsLike | boolean | undefined {
    if (typeof options === 'boolean' || options === undefined) return options;
    const mapped: AddEventListenerOptionsLike = {};
    if (options.capture !== undefined) mapped.capture = options.capture;
    if (options.once !== undefined) mapped.once = options.once;
    if (options.passive !== undefined) mapped.passive = options.passive;
    if (options.signal !== undefined) {
      mapped.signal = options.signal as NonNullable<
        AddEventListenerOptionsLike['signal']
      >;
    }
    return mapped;
  }

  private toRemoveListenerOptions(
    options?: boolean | EventListenerOptions,
  ): EventListenerOptionsLike | boolean | undefined {
    if (typeof options === 'boolean' || options === undefined) return options;
    const mapped: EventListenerOptionsLike = {};
    if (options.capture !== undefined) mapped.capture = options.capture;
    return mapped;
  }

  /**
   * Overrides addEventListener to optionally return an unsubscribe function.
   * This is a convenience for modern frontend frameworks.
   */
  override addEventListener(
    type: string,
    callback:
      | ((event: ConversationEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | AddEventListenerOptions,
  ): void | (() => void) {
    if (!callback) return;
    return this.eventHub.addEventListener(
      type as ConversationEventType,
      callback as EventListenerLike<ConversationEvent>,
      this.toAddListenerOptions(options),
    );
  }

  /**
   * Removes a listener registered with addEventListener.
   */
  override removeEventListener(
    type: string,
    callback:
      | ((event: ConversationEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!callback) return;
    this.eventHub.removeEventListener(
      type as ConversationEventType,
      callback as EventListenerLike<ConversationEvent>,
      this.toRemoveListenerOptions(options),
    );
  }

  /**
   * Dispatches a DOM-style event through the event-emission target.
   */
  override dispatchEvent(
    event:
      | Event
      | EmissionEvent<ConversationEvents[ConversationEventType], ConversationEventType>,
  ): boolean {
    return this.eventHub.dispatchEvent(
      event as Parameters<typeof this.eventHub.dispatchEvent>[0],
    );
  }

  /**
   * Watches the current conversation state.
   * @param run - Callback called with the current conversation whenever it changes.
   * @returns An unsubscribe function.
   */
  watch(run: (value: ConversationHistory) => void): () => void {
    run(this.current);

    const handler = (event: ConversationEvent) => {
      if (event?.detail?.conversation) {
        run(event.detail.conversation);
      }
    };

    const unsubscribe = this.addEventListener(
      'change',
      handler as (event: ConversationEvent) => void,
    );
    return (unsubscribe as () => void) || (() => {});
  }

  on<K extends ConversationEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ): ObservableLike<EmissionEvent<ConversationEvents[K], K>> {
    return this.eventHub.on(type, options);
  }

  once<K extends ConversationEventType>(
    type: K,
    listener: (event: EmissionEvent<ConversationEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ): () => void {
    return this.eventHub.once(type, listener, options);
  }

  subscribe<K extends ConversationEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<ConversationEvents[K], K>>
      | ((value: EmissionEvent<ConversationEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription {
    return this.eventHub.subscribe(type, observerOrNext, error, complete);
  }

  toObservable(): ObservableLike<
    EmissionEvent<ConversationEvents[ConversationEventType], ConversationEventType>
  > {
    return this.eventHub.toObservable();
  }

  events<K extends ConversationEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ): AsyncIterableIterator<EmissionEvent<ConversationEvents[K], K>> {
    return this.eventHub.events(type, options);
  }

  complete(): void {
    this.eventHub.complete();
  }

  get completed(): boolean {
    return this.eventHub.completed;
  }

  /**
   * Returns the current conversation.
   * Useful for useSyncExternalStore in React.
   */
  getSnapshot(): ConversationHistory {
    return this.current;
  }

  /**
   * The current conversation state.
   */
  get current(): ConversationHistory {
    return this.currentNode.conversation;
  }

  /**
   * Returns the message IDs for the current conversation.
   */
  get ids(): string[] {
    return getMessageIds(this.current);
  }

  /**
   * Whether an undo operation is possible.
   */
  get canUndo(): boolean {
    return this.currentNode.parent !== null;
  }

  /**
   * Whether a redo operation is possible.
   */
  get canRedo(): boolean {
    return this.currentNode.children.length > 0;
  }

  /**
   * Returns the environment associated with this history.
   */
  get env(): ConversationEnvironment {
    return this.environment;
  }

  /**
   * Returns the number of branches available at the current level.
   */
  get branchCount(): number {
    return this.currentNode.parent ? this.currentNode.parent.children.length : 1;
  }

  /**
   * Returns the index of the current branch at this level.
   */
  get branchIndex(): number {
    if (!this.currentNode.parent) return 0;
    return this.currentNode.parent.children.indexOf(this.currentNode);
  }

  /**
   * Returns the number of alternate paths available from the current state.
   */
  get redoCount(): number {
    return this.currentNode.children.length;
  }

  private createChangeContext(
    previousConversation: ConversationHistory,
    nextConversation: ConversationHistory,
    action: Extract<
      ConversationActionType,
      'messages.appended' | 'messages.updated' | 'messages.removed'
    >,
  ): ConversationChangeContext {
    const diff = diffConversationMessages(previousConversation, nextConversation);
    const messageIds =
      action === 'messages.appended'
        ? diff.appended
        : action === 'messages.updated'
          ? diff.updated
          : diff.removed;
    const toolCallIds = collectToolCallIds(
      action === 'messages.removed' ? previousConversation : nextConversation,
      messageIds,
    );
    return {
      ...(messageIds.length > 0 ? { messageIds } : {}),
      ...(toolCallIds ? { toolCallIds } : {}),
    };
  }

  private pushWithEvents(
    next: ConversationHistory,
    changeAction: Exclude<ConversationActionType, 'push' | 'undo' | 'redo' | 'switch'>,
    context?: ConversationChangeContext,
  ): void {
    this.commit(next, changeAction, ['push', changeAction], context);
  }

  /**
   * Pushes a new conversation state onto the history.
   * If the current state is not a leaf, a new branch is created.
   */
  push(next: ConversationHistory): void {
    this.commit(next, 'push', ['push']);
  }

  /**
   * Reverts to the previous conversation state.
   * @returns The conversation state after undo, or undefined if not possible.
   */
  undo(): ConversationHistory | undefined {
    if (this.currentNode.parent) {
      const previousConversation = this.current;
      this.currentNode = this.currentNode.parent;
      this.emitConversationEvent(
        'change',
        this.buildEventDetail('undo', previousConversation),
      );
      this.emitConversationEvent('undo', this.buildEventDetail('undo', previousConversation));
      return this.current;
    }
    return undefined;
  }

  /**
   * Advances to the next conversation state.
   * @param childIndex - The index of the branch to follow (default: 0).
   * @returns The conversation state after redo, or undefined if not possible.
   */
  redo(childIndex: number = 0): ConversationHistory | undefined {
    const next = this.currentNode.children[childIndex];
    if (next) {
      const previousConversation = this.current;
      this.currentNode = next;
      this.emitConversationEvent(
        'change',
        this.buildEventDetail('redo', previousConversation),
      );
      this.emitConversationEvent('redo', this.buildEventDetail('redo', previousConversation));
      return this.current;
    }
    return undefined;
  }

  /**
   * Switches to a different branch at the current level.
   * @param index - The index of the sibling branch to switch to.
   * @returns The new conversation state, or undefined if not possible.
   */
  switchToBranch(index: number): ConversationHistory | undefined {
    if (this.currentNode.parent) {
      const target = this.currentNode.parent.children[index];
      if (target) {
        const previousConversation = this.current;
        this.currentNode = target;
        this.emitConversationEvent(
          'change',
          this.buildEventDetail('switch', previousConversation),
        );
        this.emitConversationEvent(
          'switch',
          this.buildEventDetail('switch', previousConversation),
        );
        return this.current;
      }
    }
    return undefined;
  }

  /**
   * Returns the sequence of conversations from root to current.
   */
  getPath(): ConversationHistory[] {
    const path: ConversationHistory[] = [];
    let curr: HistoryNode | null = this.currentNode;
    while (curr) {
      path.unshift(curr.conversation);
      curr = curr.parent;
    }
    return path;
  }

  // --- QUERY METHODS ---

  /**
   * Returns messages from the current conversation.
   */
  getMessages(options?: { includeHidden?: boolean }): ReadonlyArray<Message> {
    return getMessages(this.current, options);
  }

  /**
   * Returns the message at the specified position.
   */
  getMessageAtPosition(position: number): Message | undefined {
    return getMessageAtPosition(this.current, position);
  }

  /**
   * Returns all message IDs for the current conversation in order.
   */
  getMessageIds(): string[] {
    return getMessageIds(this.current);
  }

  /**
   * Returns the message with the specified ID, if present.
   */
  getMessageById(id: string): Message | undefined {
    return getMessageById(this.current, id);
  }

  /**
   * Shorthand for getMessageById.
   */
  get(id: string): Message | undefined {
    return getMessageById(this.current, id);
  }

  /**
   * Filters messages using a predicate.
   */
  searchMessages(predicate: (m: Message) => boolean): Message[] {
    return searchConversationMessages(this.current, predicate);
  }

  /**
   * Computes basic statistics for the current conversation.
   */
  getStatistics() {
    return getStatistics(this.current);
  }

  /**
   * Returns true if any system message exists in the current conversation.
   */
  hasSystemMessage(): boolean {
    return hasSystemMessage(this.current);
  }

  /**
   * Returns the first system message in the current conversation, if any.
   */
  getFirstSystemMessage(): Message | undefined {
    return getFirstSystemMessage(this.current);
  }

  /**
   * Returns all system messages in the current conversation.
   */
  getSystemMessages(): ReadonlyArray<Message> {
    return getSystemMessages(this.current);
  }

  /**
   * Converts the current conversation to external chat message format.
   */
  toChatMessages() {
    return toChatMessages(this.current);
  }

  /**
   * Estimates tokens for the current conversation.
   */
  estimateTokens(estimator?: (message: Message) => number): number {
    return estimateConversationTokens(this.current, estimator, this.env);
  }

  /**
   * Returns the most recent messages, with optional filtering.
   */
  getRecentMessages(
    count: number,
    options?: {
      includeHidden?: boolean;
      includeSystem?: boolean;
      preserveToolPairs?: boolean;
    },
  ): ReadonlyArray<Message> {
    return getRecentMessages(this.current, count, options);
  }

  /**
   * Returns the current streaming message, if any.
   */
  getStreamingMessage(): Message | undefined {
    return getStreamingMessage(this.current);
  }

  // --- MUTATION METHODS ---

  /**
   * Appends one or more messages to the history.
   */
  appendMessages(...inputs: MessageInput[]): void {
    const previousConversation = this.current;
    const nextConversation = appendMessages(this.current, ...inputs, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.appended',
      this.createChangeContext(previousConversation, nextConversation, 'messages.appended'),
    );
  }

  /**
   * Appends a user message to the history.
   */
  appendUserMessage(
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void {
    const previousConversation = this.current;
    const nextConversation = appendUserMessage(this.current, content, metadata, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.appended',
      this.createChangeContext(previousConversation, nextConversation, 'messages.appended'),
    );
  }

  /**
   * Appends an assistant message to the history.
   */
  appendAssistantMessage(
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void {
    const previousConversation = this.current;
    const nextConversation = appendAssistantMessage(this.current, content, metadata, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.appended',
      this.createChangeContext(previousConversation, nextConversation, 'messages.appended'),
    );
  }

  /**
   * Appends a system message to the history.
   */
  appendSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    const previousConversation = this.current;
    const nextConversation = appendSystemMessage(this.current, content, metadata, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.appended',
      this.createChangeContext(previousConversation, nextConversation, 'messages.appended'),
    );
  }

  /**
   * Prepends a system message to the history.
   */
  prependSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    const previousConversation = this.current;
    const nextConversation = prependSystemMessage(this.current, content, metadata, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.appended',
      this.createChangeContext(previousConversation, nextConversation, 'messages.appended'),
    );
  }

  /**
   * Replaces the first system message or prepends one if none exist.
   */
  replaceSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    const previousConversation = this.current;
    const nextConversation = replaceSystemMessage(this.current, content, metadata, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.updated',
      this.createChangeContext(previousConversation, nextConversation, 'messages.updated'),
    );
  }

  /**
   * Collapses multiple system messages into a single message.
   */
  collapseSystemMessages(): void {
    const previousConversation = this.current;
    const nextConversation = collapseSystemMessages(this.current, this.env);
    const action =
      previousConversation.ids.length === nextConversation.ids.length
        ? 'messages.updated'
        : 'messages.removed';
    this.pushWithEvents(
      nextConversation,
      action,
      this.createChangeContext(previousConversation, nextConversation, action),
    );
  }

  /**
   * Redacts the message at the given position.
   */
  redactMessageAtPosition(
    position: number,
    placeholderOrOptions?: string | RedactMessageOptions,
  ): void {
    const previousConversation = this.current;
    const nextConversation = redactMessageAtPosition(
      this.current,
      position,
      placeholderOrOptions,
      this.env,
    );
    this.pushWithEvents(
      nextConversation,
      'messages.updated',
      this.createChangeContext(previousConversation, nextConversation, 'messages.updated'),
    );
  }

  /**
   * Truncates the conversation from a specific position.
   */
  truncateFromPosition(
    position: number,
    options?: { preserveSystemMessages?: boolean; preserveToolPairs?: boolean },
  ): void {
    const previousConversation = this.current;
    const nextConversation = truncateFromPosition(this.current, position, options, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.removed',
      this.createChangeContext(previousConversation, nextConversation, 'messages.removed'),
    );
  }

  /**
   * Truncates the conversation to fit within a token limit.
   */
  truncateToTokenLimit(maxTokens: number, options?: TruncateOptions): void {
    const previousConversation = this.current;
    const nextConversation = truncateToTokenLimit(this.current, maxTokens, options, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.removed',
      this.createChangeContext(previousConversation, nextConversation, 'messages.removed'),
    );
  }

  /**
   * Appends a streaming message placeholder and returns its ID.
   */
  appendStreamingMessage(
    role: 'assistant' | 'user',
    metadata?: Record<string, JSONValue>,
  ): string {
    const { conversation, messageId } = appendStreamingMessage(
      this.current,
      role,
      metadata,
      this.env,
    );
    this.commit(conversation, 'stream.started', ['push', 'messages.appended', 'stream.started'], {
      messageIds: [messageId],
    });
    return messageId;
  }

  /**
   * Updates a streaming message's content.
   */
  updateStreamingMessage(messageId: string, content: string): void {
    const nextConversation = updateStreamingMessage(this.current, messageId, content, this.env);
    this.commit(nextConversation, 'stream.updated', ['push', 'messages.updated', 'stream.updated'], {
      messageIds: [messageId],
    });
  }

  /**
   * Finalizes a streaming message and optionally adds metadata or token usage.
   */
  finalizeStreamingMessage(
    messageId: string,
    options?: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> },
  ): void {
    const nextConversation = finalizeStreamingMessage(
      this.current,
      messageId,
      options,
      this.env,
    );
    this.commit(
      nextConversation,
      'stream.finalized',
      ['push', 'messages.updated', 'stream.finalized'],
      { messageIds: [messageId] },
    );
  }

  /**
   * Cancels a streaming message by removing it from the conversation.
   */
  cancelStreamingMessage(messageId: string): void {
    const nextConversation = cancelStreamingMessage(this.current, messageId, this.env);
    this.commit(
      nextConversation,
      'stream.cancelled',
      ['push', 'messages.removed', 'stream.cancelled'],
      { messageIds: [messageId] },
    );
  }

  appendToolCall(
    toolCall: AppendableToolCallInput,
    options?: Parameters<typeof appendToolCall>[2],
  ): void {
    const nextConversation = appendToolCall(this.current, toolCall, options, this.env);
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(nextConversation, 'tool-calls.appended', ['push', 'messages.appended', 'tool-calls.appended'], context);
  }

  appendToolCalls(toolCalls: ReadonlyArray<AppendableToolCallInput>): void {
    const nextConversation = appendToolCalls(this.current, toolCalls, this.env);
    if (nextConversation === this.current) {
      return;
    }
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(nextConversation, 'tool-calls.appended', ['push', 'messages.appended', 'tool-calls.appended'], context);
  }

  appendToolResult(
    toolResult: AppendableToolResult,
    options?: Parameters<typeof appendToolResult>[2],
  ): void {
    const nextConversation = appendToolResult(this.current, toolResult, options, this.env);
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  appendToolResults(toolResults: ReadonlyArray<AppendableToolResult>): void {
    const nextConversation = appendToolResults(this.current, toolResults, this.env);
    if (nextConversation === this.current) {
      return;
    }
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  async appendToolResultAsync(
    toolResult: AppendableToolResult,
    options?: Parameters<typeof appendToolResultAsync>[2],
  ): Promise<void> {
    const nextConversation = await appendToolResultAsync(
      this.current,
      toolResult,
      options,
      this.env,
    );
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  async appendToolResultsAsync(
    toolResults: ReadonlyArray<AppendableToolResult>,
  ): Promise<void> {
    const nextConversation = await appendToolResultsAsync(
      this.current,
      toolResults,
      this.env,
    );
    if (nextConversation === this.current) {
      return;
    }
    const context = this.createChangeContext(
      this.current,
      nextConversation,
      'messages.appended',
    );
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  getPendingToolCalls(): ReturnType<typeof getPendingToolCalls> {
    return getPendingToolCalls(this.current);
  }

  getToolInteractions(): ToolInteraction[] {
    return getToolInteractions(this.current);
  }

  static async fromProvider(
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    const adapter = await loadConversationAdapter(provider);
    return new Conversation(adapter.import(payload), environment);
  }

  async toProvider(
    provider: ConversationProvider,
    options?: unknown,
  ): Promise<OpenAIMessage[] | AnthropicConversation | GeminiConversation> {
    const adapter = await loadConversationAdapter(provider);
    return adapter.export(this.current, options) as
      | OpenAIMessage[]
      | AnthropicConversation
      | GeminiConversation;
  }

  async appendProvider(
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
  ): Promise<void> {
    const adapter = await loadConversationAdapter(provider);
    const nextConversation = adapter.append(this.current, payload);
    if (nextConversation === this.current) {
      return;
    }
    const diff = diffConversationMessages(this.current, nextConversation);
    const appendedIds = diff.appended;
    const updatedIds = diff.updated;
    const removedIds = diff.removed;
    const action =
      removedIds.length > 0
        ? 'messages.removed'
        : updatedIds.length > 0
          ? 'messages.updated'
          : 'messages.appended';
    const messageIds =
      action === 'messages.removed'
        ? removedIds
        : action === 'messages.updated'
          ? updatedIds
          : appendedIds;
    const toolCallIds = collectToolCallIds(nextConversation, messageIds);
    this.commit(nextConversation, action, ['push', action], {
      ...(messageIds.length > 0 ? { messageIds } : {}),
      ...(toolCallIds ? { toolCallIds } : {}),
    });
  }

  /**
   * Captures the entire history tree and current state in a plain snapshot.
   */
  snapshot(): ConversationSnapshot {
    const getPath = (node: HistoryNode): number[] => {
      const path: number[] = [];
      let curr = node;
      while (curr.parent) {
        path.unshift(curr.parent.children.indexOf(curr));
        curr = curr.parent;
      }
      return path;
    };

    const serializeNode = (node: HistoryNode): ConversationNodeSnapshot => ({
      conversation: node.conversation,
      children: node.children.map(serializeNode),
    });

    let root = this.currentNode;
    while (root.parent) {
      root = root.parent;
    }

    return {
      root: serializeNode(root),
      currentPath: getPath(this.currentNode),
    };
  }

  /**
   * Reconstructs a Conversation instance from JSON.
   */
  static from(
    json: ConversationSnapshot,
    environment?: Partial<ConversationEnvironment>,
  ): Conversation {
    const rootConv = deserializeConversationHistory(json.root.conversation);
    const conversation = new Conversation(rootConv, environment);

    // Recursive function to build the tree
    const buildTree = (
      nodeJSON: ConversationNodeSnapshot,
      parentNode: HistoryNode,
    ): HistoryNode => {
      const nodeConv = deserializeConversationHistory(nodeJSON.conversation);
      const node: HistoryNode = {
        conversation: nodeConv,
        parent: parentNode,
        children: [],
      };
      node.children = nodeJSON.children.map((child) => buildTree(child, node));
      return node;
    };

    const h = conversation as unknown as { currentNode: HistoryNode };
    const rootNode = h.currentNode;
    rootNode.children = json.root.children.map((child) => buildTree(child, rootNode));

    // Traverse to find the current node
    let current: HistoryNode = rootNode;
    for (const index of json.currentPath) {
      const target = current.children[index];
      if (target) {
        current = target;
      }
    }
    h.currentNode = current;

    return conversation;
  }

  /**
   * Creates a Conversation from OpenAI SDK messages.
   */
  static async fromOpenAIMessages(
    messages: ReadonlyArray<OpenAIMessage>,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('openai', [...messages], environment);
  }

  /**
   * Creates a Conversation from Anthropic SDK messages.
   */
  static async fromAnthropicMessages(
    payload: AnthropicConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('anthropic', payload, environment);
  }

  /**
   * Creates a Conversation from Gemini SDK messages.
   */
  static async fromGeminiMessages(
    payload: GeminiConversation,
    environment?: Partial<ConversationEnvironment>,
  ): Promise<Conversation> {
    return Conversation.fromProvider('gemini', payload, environment);
  }

  /**
   * Converts the current conversation to OpenAI Chat Completions messages.
   */
  async toOpenAIMessages(): Promise<OpenAIMessage[]> {
    return this.toProvider('openai', { groupToolCalls: false }) as Promise<OpenAIMessage[]>;
  }

  /**
   * Converts the current conversation to grouped OpenAI Chat Completions messages.
   */
  async toOpenAIMessagesGrouped(): Promise<OpenAIMessage[]> {
    return this.toProvider('openai', { groupToolCalls: true }) as Promise<OpenAIMessage[]>;
  }

  /**
   * Converts the current conversation to Anthropic Messages payloads.
   */
  async toAnthropicMessages(): Promise<AnthropicConversation> {
    return this.toProvider('anthropic') as Promise<AnthropicConversation>;
  }

  /**
   * Converts the current conversation to Gemini contents.
   */
  async toGeminiMessages(): Promise<GeminiConversation> {
    return this.toProvider('gemini') as Promise<GeminiConversation>;
  }

  /**
   * Binds a function to this history instance.
   * The first argument of the function must be a ConversationHistory.
   * If the function returns a new ConversationHistory, it is automatically pushed to the history.
   */
  bind<T extends unknown[], R>(
    fn: (
      conversation: ConversationHistory,
      ...args: [...T, Partial<ConversationEnvironment>?]
    ) => R,
  ): (...args: T) => R {
    return (...args: T): R => {
      // We pass the history's environment as the last argument if the function supports it
      const boundFn = fn as (conversation: ConversationHistory, ...args: unknown[]) => R;
      const result = boundFn(this.current, ...args, this.env);

      if (isConversationHistory(result)) {
        this.push(result);
      }

      return result;
    };
  }

  /**
   * Cleans up all listeners and resources.
   */
  [Symbol.dispose](): void {
    this.complete();
    // Clear references to help GC
    let root: HistoryNode | null = this.currentNode;
    while (root?.parent) {
      root = root.parent;
    }

    const clearNode = (node: HistoryNode) => {
      for (const child of node.children) {
        clearNode(child);
      }
      node.children = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const n = node as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      n.parent = null;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      n.conversation = null;
    };

    if (root) clearNode(root);
    this.eventHub.clear();
  }
}

/**
 * Simple type guard to check if a value is a ConversationHistory.
 */
function isConversationHistory(value: unknown): value is ConversationHistory {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ConversationHistory).schemaVersion === 'number' &&
    typeof (value as ConversationHistory).id === 'string' &&
    typeof (value as ConversationHistory).status === 'string' &&
    (value as ConversationHistory).metadata !== null &&
    typeof (value as ConversationHistory).metadata === 'object' &&
    Array.isArray((value as ConversationHistory).ids) &&
    typeof (value as ConversationHistory).messages === 'object' &&
    (value as ConversationHistory).messages !== null &&
    !Array.isArray((value as ConversationHistory).messages) &&
    typeof (value as ConversationHistory).createdAt === 'string' &&
    typeof (value as ConversationHistory).updatedAt === 'string'
  );
}
