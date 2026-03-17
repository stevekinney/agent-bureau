import type {
  AddEventListenerOptionsLike,
  EmissionEvent,
  EventListenerLike,
  EventListenerOptionsLike,
  EventTargetLike,
} from 'event-emission';
import { createEventTarget } from 'event-emission';

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
  appendUserMessage,
  collapseSystemMessages,
  createConversation,
  deserializeConversation,
  getFirstSystemMessage,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getStatistics,
  getSystemMessages,
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
  Conversation,
  ConversationHistorySnapshot,
  HistoryNodeSnapshot,
  JSONValue,
  Message,
  MessageInput,
  TokenUsage,
} from './types';

/**
 * Event detail for conversation history changes.
 */
export interface ConversationHistoryEventDetail {
  type: ConversationHistoryActionType;
  conversation: Conversation;
}

export type ConversationHistoryEvent = EmissionEvent<
  ConversationHistoryEventDetail,
  ConversationHistoryEventType
>;

type ConversationHistoryActionType = 'push' | 'undo' | 'redo' | 'switch';
type ConversationHistoryEventType = 'change' | ConversationHistoryActionType;
type ConversationHistoryEventMap = Record<
  ConversationHistoryEventType,
  ConversationHistoryEventDetail
>;
type ConversationHistoryEventTarget = EventTargetLike<ConversationHistoryEventMap>;

interface HistoryNode {
  conversation: Conversation;
  parent: HistoryNode | null;
  children: HistoryNode[];
}

/**
 * Manages a stack of conversation versions to support undo, redo, and branching.
 */
export class ConversationHistory extends EventTarget {
  private currentNode: HistoryNode;
  private environment: ConversationEnvironment;
  private readonly events: ConversationHistoryEventTarget;

  constructor(
    initial: Conversation = createConversation(),
    environment?: Partial<ConversationEnvironment>,
  ) {
    super();
    this.environment = resolveConversationEnvironment(environment);
    this.events = createEventTarget<ConversationHistoryEventMap>();
    const safeInitial = ensureConversationSafe(initial);
    this.currentNode = {
      conversation: safeInitial,
      parent: null,
      children: [],
    };
  }

  /**
   * Dispatches a change event.
   */
  private notifyChange(type: ConversationHistoryActionType): void {
    const detail: ConversationHistoryEventDetail = {
      type,
      conversation: this.current,
    };
    this.events.dispatchEvent({ type: 'change', detail });
    this.events.dispatchEvent({ type, detail });
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
      | ((event: ConversationHistoryEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | AddEventListenerOptions,
  ): void | (() => void) {
    if (!callback) return;
    return this.events.addEventListener(
      type as ConversationHistoryEventType,
      callback as EventListenerLike<ConversationHistoryEvent>,
      this.toAddListenerOptions(options),
    );
  }

  /**
   * Removes a listener registered with addEventListener.
   */
  override removeEventListener(
    type: string,
    callback:
      | ((event: ConversationHistoryEvent) => void)
      | EventListenerOrEventListenerObject
      | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!callback) return;
    this.events.removeEventListener(
      type as ConversationHistoryEventType,
      callback as EventListenerLike<ConversationHistoryEvent>,
      this.toRemoveListenerOptions(options),
    );
  }

  /**
   * Dispatches a DOM-style event through the event-emission target.
   */
  override dispatchEvent(event: Event): boolean {
    return this.events.dispatchEvent(
      event as Parameters<ConversationHistoryEventTarget['dispatchEvent']>[0],
    );
  }

  /**
   * Subscribes to conversation changes.
   * This follows the Svelte store contract, making ConversationHistory a valid Svelte store.
   * @param run - Callback called with the current conversation whenever it changes.
   * @returns An unsubscribe function.
   */
  subscribe(run: (value: Conversation) => void): () => void {
    // Call immediately with current value (Svelte store contract)
    run(this.current);

    const handler = (event: ConversationHistoryEvent) => {
      if (event?.detail?.conversation) {
        run(event.detail.conversation);
      }
    };

    const unsubscribe = this.addEventListener(
      'change',
      handler as (event: ConversationHistoryEvent) => void,
    );
    return (unsubscribe as () => void) || (() => {});
  }

  /**
   * Returns the current conversation.
   * Useful for useSyncExternalStore in React.
   */
  getSnapshot(): Conversation {
    return this.current;
  }

  /**
   * The current conversation state.
   */
  get current(): Conversation {
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

  /**
   * Pushes a new conversation state onto the history.
   * If the current state is not a leaf, a new branch is created.
   */
  push(next: Conversation): void {
    const newNode: HistoryNode = {
      conversation: next,
      parent: this.currentNode,
      children: [],
    };
    this.currentNode.children.push(newNode);
    this.currentNode = newNode;
    this.notifyChange('push');
  }

  /**
   * Reverts to the previous conversation state.
   * @returns The conversation state after undo, or undefined if not possible.
   */
  undo(): Conversation | undefined {
    if (this.currentNode.parent) {
      this.currentNode = this.currentNode.parent;
      this.notifyChange('undo');
      return this.current;
    }
    return undefined;
  }

  /**
   * Advances to the next conversation state.
   * @param childIndex - The index of the branch to follow (default: 0).
   * @returns The conversation state after redo, or undefined if not possible.
   */
  redo(childIndex: number = 0): Conversation | undefined {
    const next = this.currentNode.children[childIndex];
    if (next) {
      this.currentNode = next;
      this.notifyChange('redo');
      return this.current;
    }
    return undefined;
  }

  /**
   * Switches to a different branch at the current level.
   * @param index - The index of the sibling branch to switch to.
   * @returns The new conversation state, or undefined if not possible.
   */
  switchToBranch(index: number): Conversation | undefined {
    if (this.currentNode.parent) {
      const target = this.currentNode.parent.children[index];
      if (target) {
        this.currentNode = target;
        this.notifyChange('switch');
        return this.current;
      }
    }
    return undefined;
  }

  /**
   * Returns the sequence of conversations from root to current.
   */
  getPath(): Conversation[] {
    const path: Conversation[] = [];
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
    this.push(appendMessages(this.current, ...inputs, this.env));
  }

  /**
   * Appends a user message to the history.
   */
  appendUserMessage(
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void {
    this.push(appendUserMessage(this.current, content, metadata, this.env));
  }

  /**
   * Appends an assistant message to the history.
   */
  appendAssistantMessage(
    content: MessageInput['content'],
    metadata?: Record<string, JSONValue>,
  ): void {
    this.push(appendAssistantMessage(this.current, content, metadata, this.env));
  }

  /**
   * Appends a system message to the history.
   */
  appendSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    this.push(appendSystemMessage(this.current, content, metadata, this.env));
  }

  /**
   * Prepends a system message to the history.
   */
  prependSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    this.push(prependSystemMessage(this.current, content, metadata, this.env));
  }

  /**
   * Replaces the first system message or prepends one if none exist.
   */
  replaceSystemMessage(content: string, metadata?: Record<string, JSONValue>): void {
    this.push(replaceSystemMessage(this.current, content, metadata, this.env));
  }

  /**
   * Collapses multiple system messages into a single message.
   */
  collapseSystemMessages(): void {
    this.push(collapseSystemMessages(this.current, this.env));
  }

  /**
   * Redacts the message at the given position.
   */
  redactMessageAtPosition(
    position: number,
    placeholderOrOptions?: string | RedactMessageOptions,
  ): void {
    this.push(
      redactMessageAtPosition(this.current, position, placeholderOrOptions, this.env),
    );
  }

  /**
   * Truncates the conversation from a specific position.
   */
  truncateFromPosition(
    position: number,
    options?: { preserveSystemMessages?: boolean; preserveToolPairs?: boolean },
  ): void {
    this.push(truncateFromPosition(this.current, position, options, this.env));
  }

  /**
   * Truncates the conversation to fit within a token limit.
   */
  truncateToTokenLimit(maxTokens: number, options?: TruncateOptions): void {
    this.push(truncateToTokenLimit(this.current, maxTokens, options, this.env));
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
    this.push(conversation);
    return messageId;
  }

  /**
   * Updates a streaming message's content.
   */
  updateStreamingMessage(messageId: string, content: string): void {
    this.push(updateStreamingMessage(this.current, messageId, content, this.env));
  }

  /**
   * Finalizes a streaming message and optionally adds metadata or token usage.
   */
  finalizeStreamingMessage(
    messageId: string,
    options?: { tokenUsage?: TokenUsage; metadata?: Record<string, JSONValue> },
  ): void {
    this.push(finalizeStreamingMessage(this.current, messageId, options, this.env));
  }

  /**
   * Cancels a streaming message by removing it from the conversation.
   */
  cancelStreamingMessage(messageId: string): void {
    this.push(cancelStreamingMessage(this.current, messageId, this.env));
  }

  /**
   * Captures the entire history tree and current state in a plain snapshot.
   */
  snapshot(): ConversationHistorySnapshot {
    const getPath = (node: HistoryNode): number[] => {
      const path: number[] = [];
      let curr = node;
      while (curr.parent) {
        path.unshift(curr.parent.children.indexOf(curr));
        curr = curr.parent;
      }
      return path;
    };

    const serializeNode = (node: HistoryNode): HistoryNodeSnapshot => ({
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
   * Reconstructs a ConversationHistory instance from JSON.
   */
  static from(
    json: ConversationHistorySnapshot,
    environment?: Partial<ConversationEnvironment>,
  ): ConversationHistory {
    const rootConv = deserializeConversation(json.root.conversation);
    const history = new ConversationHistory(rootConv, environment);

    // Recursive function to build the tree
    const buildTree = (
      nodeJSON: HistoryNodeSnapshot,
      parentNode: HistoryNode,
    ): HistoryNode => {
      const nodeConv = deserializeConversation(nodeJSON.conversation);
      const node: HistoryNode = {
        conversation: nodeConv,
        parent: parentNode,
        children: [],
      };
      node.children = nodeJSON.children.map((child) => buildTree(child, node));
      return node;
    };

    const h = history as unknown as { currentNode: HistoryNode };
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

    return history;
  }

  /**
   * Binds a function to this history instance.
   * The first argument of the function must be a Conversation.
   * If the function returns a new Conversation, it is automatically pushed to the history.
   */
  bind<T extends unknown[], R>(
    fn: (
      conversation: Conversation,
      ...args: [...T, Partial<ConversationEnvironment>?]
    ) => R,
  ): (...args: T) => R {
    return (...args: T): R => {
      // We pass the history's environment as the last argument if the function supports it
      const boundFn = fn as (conversation: Conversation, ...args: unknown[]) => R;
      const result = boundFn(this.current, ...args, this.env);

      if (isConversation(result)) {
        this.push(result);
      }

      return result;
    };
  }

  /**
   * Cleans up all listeners and resources.
   */
  [Symbol.dispose](): void {
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
    this.events.clear();
  }
}

/**
 * Simple type guard to check if a value is a Conversation.
 */
function isConversation(value: unknown): value is Conversation {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Conversation).schemaVersion === 'number' &&
    typeof (value as Conversation).id === 'string' &&
    typeof (value as Conversation).status === 'string' &&
    (value as Conversation).metadata !== null &&
    typeof (value as Conversation).metadata === 'object' &&
    Array.isArray((value as Conversation).ids) &&
    typeof (value as Conversation).messages === 'object' &&
    (value as Conversation).messages !== null &&
    !Array.isArray((value as Conversation).messages) &&
    typeof (value as Conversation).createdAt === 'string' &&
    typeof (value as Conversation).updatedAt === 'string'
  );
}
