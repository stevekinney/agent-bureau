import {
  CompletableEventTarget,
  type EventIteratorOptions,
  type ObservableLike,
  type Observer,
  type Subscription,
} from 'lifecycle';

import type { AnthropicConversation } from './adapters/anthropic';
import type { GeminiConversation } from './adapters/gemini';
import type { OpenAIMessage } from './adapters/openai';
import {
  compactConversation,
  type CompactionOptions,
  type CompactionResult,
  type Summarizer,
} from './compaction/index';
import {
  estimateConversationTokens,
  getRecentMessages,
  truncateFromPosition,
  type TruncateOptions,
  truncateToTokenLimit,
} from './context';
import type { RedactMessageOptions, ToolInteraction } from './conversation/index';
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
import { type ConversationEnvironment, resolveConversationEnvironment } from './environment';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventMap,
  ConversationEventType,
} from './events';
import {
  ConversationChangeEvent,
  conversationEventConstructors,
  PersistenceErrorEvent,
} from './events';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  updateStreamingMessage,
} from './streaming';
import type {
  AppendableToolCallInput,
  AppendableToolResult,
  ConversationHistory,
  ConversationNodeSnapshot,
  ConversationProvider,
  ConversationSnapshot,
  JSONValue,
  Message,
  MessageInput,
  TokenUsage,
} from './types';

export type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventDetail,
  ConversationEventMap,
  ConversationEventType,
} from './events';

/**
 * Re-export the old ConversationEvents name as an alias for the event map.
 * Downstream code (e.g. operative) imports `ConversationEvents` from the
 * public barrel, so keep a single definition here.
 */
export type { ConversationEventMap as ConversationEvents } from './events';

interface HistoryNode {
  conversation: ConversationHistory;
  parent: HistoryNode | null;
  children: HistoryNode[];
}

type ConversationAdapter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export: (conversation: ConversationHistory, options?: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  import: (payload: any) => ConversationHistory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
export class Conversation {
  private currentNode: HistoryNode;
  private environment: ConversationEnvironment;
  private readonly emitter = new CompletableEventTarget<ConversationEventMap>();

  constructor(
    initial: ConversationHistory = createConversationHistory(),
    environment?: Partial<ConversationEnvironment>,
  ) {
    this.environment = resolveConversationEnvironment(environment);
    const safeInitial = ensureConversationSafe(initial);
    this.currentNode = {
      conversation: safeInitial,
      parent: null,
      children: [],
    };

    if (this.environment.persistence) {
      const persistence = this.environment.persistence;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      this.addEventListener('change', () => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          persistence.save(this.current).catch((error: unknown) => {
            this.emitter.dispatchEvent(new PersistenceErrorEvent(error));
          });
        }, 100);
      });
    }
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

  private emitConversationEvent(type: string, detail: ConversationEventDetail): void {
    const EventConstructor = conversationEventConstructors[type];
    if (EventConstructor) {
      this.emitter.dispatchEvent(new EventConstructor(detail));
    }
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

    // Prune oldest ancestors when maxHistoryDepth is exceeded
    if (this.environment.maxHistoryDepth !== undefined) {
      this.pruneToDepth(this.environment.maxHistoryDepth);
    }

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

  private pruneToDepth(maxDepth: number): void {
    // Calculate the current path length from root to current node
    let depth = 0;
    let node: HistoryNode | null = this.currentNode;
    while (node) {
      depth++;
      node = node.parent;
    }

    // Prune from the root until depth is within limit
    while (depth > maxDepth) {
      // Walk from current to root
      let root: HistoryNode = this.currentNode;
      while (root.parent) {
        root = root.parent;
      }

      // Promote root's child that is on the path to current
      const childOnPath = root.children.find((child) => {
        let curr: HistoryNode | null = this.currentNode;
        while (curr) {
          if (curr === child) return true;
          curr = curr.parent;
        }
        return false;
      });

      if (!childOnPath) break;

      // Detach the child from the old root
      childOnPath.parent = null;
      depth--;
    }
  }

  /**
   * Registers a listener for a conversation event type.
   *
   * The listener is automatically removed when the conversation is disposed
   * (i.e. when {@link complete} is called), unless the caller already
   * provided their own `signal`.
   */
  addEventListener<K extends keyof ConversationEventMap & string>(
    type: K,
    callback: ((event: ConversationEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const resolved: AddEventListenerOptions =
      typeof options === 'boolean' ? { capture: options } : { ...options };

    // Bind to the completion signal so listeners are removed on disposal.
    resolved.signal ??= this.emitter.signal;

    this.emitter.addEventListener(type, callback, resolved);
  }

  /**
   * Removes a listener registered with addEventListener.
   */
  removeEventListener<K extends keyof ConversationEventMap & string>(
    type: K,
    callback: ((event: ConversationEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void {
    this.emitter.removeEventListener(type, callback, options);
  }

  /**
   * Dispatches an event through the event target.
   */
  dispatchEvent(event: Event): boolean {
    return this.emitter.dispatchEvent(event);
  }

  /**
   * Watches the current conversation state.
   * @param run - Callback called with the current conversation whenever it changes.
   * @returns An unsubscribe function.
   */
  watch(run: (value: ConversationHistory) => void): () => void {
    run(this.current);

    const handler = (event: ConversationChangeEvent) => {
      run(event.conversation);
    };

    this.emitter.addEventListener('change', handler, { signal: this.emitter.signal });
    return () => {
      this.emitter.removeEventListener('change', handler);
    };
  }

  on<K extends keyof ConversationEventMap & string>(
    type: K,
  ): ObservableLike<ConversationEventMap[K]> {
    return this.emitter.on(type);
  }

  once<K extends keyof ConversationEventMap & string>(
    type: K,
    listener: (event: ConversationEventMap[K]) => void,
  ): void {
    this.emitter.once(type, listener);
  }

  subscribe<K extends keyof ConversationEventMap & string>(
    type: K,
    observerOrNext?: Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription {
    return this.emitter.subscribe(type, observerOrNext, error, complete);
  }

  toObservable(): ObservableLike<ConversationEventMap[keyof ConversationEventMap & string]> {
    return this.emitter.toObservable();
  }

  events<K extends keyof ConversationEventMap & string>(
    type: K,
    options?: EventIteratorOptions,
  ): AsyncIterableIterator<ConversationEventMap[K]> {
    return this.emitter.events(type, options);
  }

  complete(): void {
    this.emitter.complete();
  }

  get completed(): boolean {
    return this.emitter.completed;
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
      this.emitConversationEvent('change', this.buildEventDetail('undo', previousConversation));
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
      this.emitConversationEvent('change', this.buildEventDetail('redo', previousConversation));
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
        this.emitConversationEvent('change', this.buildEventDetail('switch', previousConversation));
        this.emitConversationEvent('switch', this.buildEventDetail('switch', previousConversation));
        return this.current;
      }
    }
    return undefined;
  }

  fork(messageId?: string): Conversation {
    const previous = this.current;
    const cloned = JSON.parse(JSON.stringify(this.current)) as ConversationHistory;

    let forkedHistory: ConversationHistory;
    if (messageId) {
      const messageIndex = cloned.ids.indexOf(messageId);
      if (messageIndex === -1) {
        throw new Error(`Message with id "${messageId}" not found`);
      }
      const truncatedIds = cloned.ids.slice(0, messageIndex + 1);
      const truncatedMessages: Record<string, Message> = {};
      for (const id of truncatedIds) {
        const message = cloned.messages[id];
        if (message) truncatedMessages[id] = message;
      }
      forkedHistory = {
        ...cloned,
        id: this.environment.randomId(),
        ids: truncatedIds,
        messages: truncatedMessages,
        updatedAt: this.environment.now(),
      };
    } else {
      forkedHistory = {
        ...cloned,
        id: this.environment.randomId(),
        updatedAt: this.environment.now(),
      };
    }

    const detail = this.buildEventDetail('session.forked', previous);
    this.emitConversationEvent('session.forked', detail);
    this.emitConversationEvent('change', detail);

    return new Conversation(forkedHistory, this.environment);
  }

  tag(label: string): void {
    const previous = this.current;
    const existingTags = (previous.metadata['_tags'] as string[] | undefined) ?? [];
    if (existingTags.includes(label)) return;

    const next: ConversationHistory = {
      ...previous,
      metadata: {
        ...previous.metadata,
        _tags: [...existingTags, label],
      },
      updatedAt: this.environment.now(),
    };

    this.commit(next, 'session.tagged', ['push', 'session.tagged']);
  }

  rename(title: string): void {
    const previous = this.current;
    if (previous.title === title) return;

    const next: ConversationHistory = {
      ...previous,
      title,
      updatedAt: this.environment.now(),
    };

    this.commit(next, 'session.renamed', ['push', 'session.renamed']);
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
  appendUserMessage(content: MessageInput['content'], metadata?: Record<string, JSONValue>): void {
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
   * Compacts the conversation by summarizing older messages.
   * The summarizer function is caller-provided, keeping this library LLM-agnostic.
   */
  async compact(summarizer: Summarizer, options?: CompactionOptions): Promise<CompactionResult> {
    const previous = this.current;
    this.emitConversationEvent(
      'compaction.started',
      this.buildEventDetail('compaction.started', previous),
    );
    const { conversation, result } = await compactConversation(
      this.current,
      summarizer,
      options,
      this.env,
    );
    if (result.compacted) {
      this.pushWithEvents(
        conversation,
        'compaction.completed',
        this.createChangeContext(previous, conversation, 'messages.removed'),
      );
    } else {
      this.emitConversationEvent(
        'compaction.completed',
        this.buildEventDetail('compaction.completed', previous),
      );
    }
    return result;
  }

  /**
   * Appends a streaming message placeholder and returns its ID.
   */
  appendStreamingMessage(role: 'assistant' | 'user', metadata?: Record<string, JSONValue>): string {
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
    this.commit(
      nextConversation,
      'stream.updated',
      ['push', 'messages.updated', 'stream.updated'],
      {
        messageIds: [messageId],
      },
    );
  }

  /**
   * Finalizes a streaming message and optionally adds metadata or token usage.
   */
  finalizeStreamingMessage(
    messageId: string,
    options?: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> },
  ): void {
    const nextConversation = finalizeStreamingMessage(this.current, messageId, options, this.env);
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
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
    this.commit(
      nextConversation,
      'tool-calls.appended',
      ['push', 'messages.appended', 'tool-calls.appended'],
      context,
    );
  }

  appendToolCalls(toolCalls: ReadonlyArray<AppendableToolCallInput>): void {
    const nextConversation = appendToolCalls(this.current, toolCalls, this.env);
    if (nextConversation === this.current) {
      return;
    }
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
    this.commit(
      nextConversation,
      'tool-calls.appended',
      ['push', 'messages.appended', 'tool-calls.appended'],
      context,
    );
  }

  appendToolResult(
    toolResult: AppendableToolResult,
    options?: Parameters<typeof appendToolResult>[2],
  ): void {
    const nextConversation = appendToolResult(this.current, toolResult, options, this.env);
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
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
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
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
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  async appendToolResultsAsync(toolResults: ReadonlyArray<AppendableToolResult>): Promise<void> {
    const nextConversation = await appendToolResultsAsync(this.current, toolResults, this.env);
    if (nextConversation === this.current) {
      return;
    }
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
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

    const rootNode = conversation.currentNode;
    rootNode.children = json.root.children.map((child) => buildTree(child, rootNode));

    // Traverse to find the current node
    let current: HistoryNode = rootNode;
    for (const index of json.currentPath) {
      const target = current.children[index];
      if (target) {
        current = target;
      }
    }
    conversation.currentNode = current;

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
    // CompletableEventTarget does not have a clear() method;
    // complete() has already been called above.
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
