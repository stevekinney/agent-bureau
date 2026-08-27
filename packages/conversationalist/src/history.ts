import {
  CompletableEventTarget,
  type EventIteratorOptions,
  type ObservableLike,
  type Observer,
  type Subscription,
} from 'lifecycle';

import type { AnthropicConversation } from './adapters/anthropic/types';
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
  rewindBeforeMessage,
  rewindBeforePosition,
  type RewindOptions,
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
  resolveToolResult,
  resolveToolResultAsync,
  searchConversationMessages,
  toChatMessages,
} from './conversation/index';
import {
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  finalizeSnapshot,
  validateSnapshot,
} from './conversation/snapshot-integrity';
import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  getMessagePluginIdentity,
  resolveConversationEnvironment,
} from './environment';
import {
  createConversationLifecycleError,
  createOperationCancelledError,
  createRevisionConflictError,
  createSerializationError,
} from './errors';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventMap,
  ConversationEventType,
} from './events';
import {
  ConversationChangeEvent,
  ConversationEvent,
  conversationEventConstructors,
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
  MessagePluginIdentity,
  TokenUsage,
} from './types';
import { CURRENT_SCHEMA_VERSION } from './types';

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
  id: string;
  revision: number;
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
  streamSequence?: number;
  correlationId?: string;
  actor?: string;
  durability?: ConversationEventDetail['durability'];
  outcome?: ConversationEventDetail['outcome'];
  reason?: string;
};

export type ConversationLifecycle = 'open' | 'closed' | 'disposed';

export interface ConversationStoreSnapshot {
  readonly conversation: ConversationHistory;
  readonly revision: number;
  readonly lifecycle: ConversationLifecycle;
}

export interface ConversationMutationOptions {
  expectedRevision: number;
  correlationId?: string;
  actor?: string;
  durability?: ConversationEventDetail['durability'];
}

export type ConversationMutationResult =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false;
      readonly revision: number;
      readonly reason: 'revision-conflict' | 'stale-external-event' | 'invalid-external-snapshot';
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
  private controllerRevision = 0;
  private forkLineage?: {
    parentConversationId: string;
    forkPointMessageId?: string;
    sourceRevision: number;
  };
  private readonly removedNodeIds = new Set<string>();
  private environment: ConversationEnvironment;
  private readonly emitter = new CompletableEventTarget<ConversationEventMap>();
  private lifecycleState: ConversationLifecycle = 'open';
  private eventSequence = 0;
  private cachedStoreSnapshot: ConversationStoreSnapshot | undefined;
  private readonly storeListeners = new Set<{ notify: () => void }>();
  private readonly operationAbortController = new AbortController();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly streamSequences = new Map<string, number>();
  private readonly pluginIdentityList: readonly MessagePluginIdentity[];

  constructor(
    initial: ConversationHistory = createConversationHistory(),
    environment?: Partial<ConversationEnvironment>,
  ) {
    this.environment = resolveConversationEnvironment(environment);
    this.pluginIdentityList = Object.freeze(
      this.environment.plugins.map((plugin, index) => {
        if (
          !plugin.id ||
          plugin.id.trim().length === 0 ||
          !Number.isSafeInteger(plugin.revision) ||
          (plugin.revision ?? 0) < 1
        ) {
          throw new TypeError(
            `Message plugin at index ${index} requires an explicit id and revision; use defineMessagePlugin()`,
          );
        }
        return getMessagePluginIdentity(plugin, index);
      }),
    );
    const duplicatePluginIdentity = this.pluginIdentityList.find(
      (identity, index, identities) =>
        identities.findIndex((candidate) => candidate.id === identity.id) !== index,
    );
    if (duplicatePluginIdentity) {
      throw new TypeError(`Duplicate message plugin identity: ${duplicatePluginIdentity.id}`);
    }
    this.environment = {
      ...this.environment,
      plugins: this.environment.plugins.map((plugin, index) => {
        const identity = this.pluginIdentityList[index]!;
        let activated = false;
        return Object.assign(
          (input: MessageInput): MessageInput => {
            if (!activated) {
              activated = true;
              this.emitConversationEvent(
                'plugin.activated',
                this.buildEventDetail('plugin.activated', this.current, {
                  outcome: 'completed',
                  plugin: identity,
                }),
              );
            }
            try {
              return plugin(input);
            } catch (error) {
              this.emitConversationEvent(
                'plugin.failed',
                this.buildEventDetail('plugin.failed', this.current, {
                  outcome: 'failed',
                  plugin: identity,
                  reason: String(error),
                }),
              );
              throw error;
            }
          },
          { id: identity.id, revision: identity.revision },
        );
      }),
    };
    const safeInitial = ensureConversationSafe(structuredClone(initial));
    this.currentNode = {
      id: `${safeInitial.id}:0`,
      revision: 0,
      conversation: safeInitial,
      parent: null,
      children: [],
    };
  }

  private buildEventDetail(
    action: ConversationActionType,
    previousConversation: ConversationHistory,
    context: ConversationChangeContext &
      Partial<
        Pick<
          ConversationEventDetail,
          | 'actor'
          | 'correlationId'
          | 'durability'
          | 'outcome'
          | 'streamSequence'
          | 'childConversationId'
          | 'plugin'
          | 'reason'
        >
      > = {},
  ): ConversationEventDetail {
    this.eventSequence += 1;
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
      revision: this.controllerRevision,
      sequence: this.eventSequence,
      correlationId: context.correlationId ?? `${this.current.id}:event:${this.eventSequence}`,
      ...(context.actor ? { actor: context.actor } : {}),
      durability: context.durability ?? 'ephemeral',
      outcome: context.outcome ?? 'accepted',
      ...(context.streamSequence !== undefined ? { streamSequence: context.streamSequence } : {}),
      ...(context.childConversationId ? { childConversationId: context.childConversationId } : {}),
      ...(context.plugin ? { plugin: context.plugin } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    };
  }

  private emitConversationEvent(type: string, detail: ConversationEventDetail): void {
    const EventConstructor = conversationEventConstructors[type];
    this.emitter.dispatchEvent(
      EventConstructor ? new EventConstructor(detail) : new ConversationEvent(type, detail),
    );
  }

  private assertOpen(): void {
    if (this.lifecycleState !== 'open') {
      throw createConversationLifecycleError(this.current.id, this.lifecycleState);
    }
  }

  private publishStoreSnapshot(): void {
    this.cachedStoreSnapshot = undefined;
    for (const subscription of [...this.storeListeners]) subscription.notify();
  }

  private async runOwnedOperation<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const startingRevision = this.controllerRevision;
    const promise = operation(this.operationAbortController.signal);
    this.inFlightOperations.add(promise);
    try {
      const result = await promise;
      if (this.lifecycleState !== 'open' || this.operationAbortController.signal.aborted) {
        throw createOperationCancelledError(this.current.id, name);
      }
      if (this.controllerRevision !== startingRevision) {
        throw createRevisionConflictError(
          this.current.id,
          startingRevision,
          this.controllerRevision,
        );
      }
      return result;
    } finally {
      this.inFlightOperations.delete(promise);
    }
  }

  private commit(
    next: ConversationHistory,
    changeAction: ConversationActionType,
    emittedEvents: readonly ConversationEventType[],
    context?: ConversationChangeContext,
  ): void {
    this.assertOpen();
    const previousConversation = this.current;
    const safeNext = ensureConversationSafe(structuredClone(next));
    this.controllerRevision += 1;
    const newNode: HistoryNode = {
      id: `${next.id}:${this.controllerRevision}`,
      revision: this.controllerRevision,
      conversation: safeNext,
      parent: this.currentNode,
      children: [],
    };
    this.currentNode.children.push(newNode);
    this.currentNode = newNode;

    // Prune oldest ancestors when maxHistoryDepth is exceeded
    const pruned =
      this.environment.maxHistoryDepth !== undefined
        ? this.pruneToDepth(this.environment.maxHistoryDepth)
        : false;

    if (pruned) {
      this.emitConversationEvent(
        'branch.pruned',
        this.buildEventDetail('branch.pruned', previousConversation, {
          durability: 'snapshot',
          outcome: 'completed',
        }),
      );
    }

    const eventContext = {
      ...context,
      correlationId:
        context?.correlationId ?? `${this.current.id}:revision:${this.controllerRevision}`,
    };
    this.emitConversationEvent(
      'change',
      this.buildEventDetail(changeAction, previousConversation, eventContext),
    );

    for (const eventType of emittedEvents) {
      if (eventType === 'change') {
        continue;
      }
      const eventAction = eventType as ConversationActionType;
      this.emitConversationEvent(
        eventType,
        this.buildEventDetail(eventAction, previousConversation, eventContext),
      );
    }
    this.publishStoreSnapshot();
  }

  private pruneToDepth(maxDepth: number): boolean {
    // Calculate the current path length from root to current node
    let depth = 0;
    let node: HistoryNode | null = this.currentNode;
    while (node) {
      depth++;
      node = node.parent;
    }

    // Prune from the root until depth is within limit
    let pruned = false;
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

      const collectRemoved = (candidate: HistoryNode): void => {
        this.removedNodeIds.add(candidate.id);
        for (const child of candidate.children) collectRemoved(child);
      };
      this.removedNodeIds.add(root.id);
      for (const discardedChild of root.children) {
        if (discardedChild !== childOnPath) collectRemoved(discardedChild);
      }

      // Detach the child from the old root
      childOnPath.parent = null;
      depth--;
      pruned = true;
    }
    return pruned;
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

  subscribe(onStoreChange: () => void): () => void;
  subscribe<K extends keyof ConversationEventMap & string>(
    type: K,
    observerOrNext?: Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
  subscribe<K extends keyof ConversationEventMap & string>(
    typeOrListener: K | (() => void),
    observerOrNext?: Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription | (() => void) {
    if (typeof typeOrListener === 'function') {
      this.assertOpen();
      const subscription = { notify: typeOrListener };
      this.storeListeners.add(subscription);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        this.storeListeners.delete(subscription);
      };
    }
    return this.emitter.subscribe(typeOrListener, observerOrNext, error, complete);
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

  close(): void {
    if (this.lifecycleState !== 'open') return;
    const previous = this.current;
    this.lifecycleState = 'closed';
    this.operationAbortController.abort(
      createOperationCancelledError(this.current.id, 'operation'),
    );
    this.emitConversationEvent(
      'controller.closed',
      this.buildEventDetail('controller.closed', previous, {
        durability: 'snapshot',
        outcome: 'completed',
      }),
    );
    this.publishStoreSnapshot();
    this.emitter.complete();
  }

  complete(): void {
    this.close();
  }

  get completed(): boolean {
    return this.lifecycleState !== 'open';
  }

  get lifecycle(): ConversationLifecycle {
    return this.lifecycleState;
  }

  get inFlightOperationCount(): number {
    return this.inFlightOperations.size;
  }

  /**
   * Returns the current conversation.
   * Useful for useSyncExternalStore in React.
   */
  getSnapshot(): ConversationStoreSnapshot {
    this.cachedStoreSnapshot ??= Object.freeze({
      conversation: this.current,
      revision: this.controllerRevision,
      lifecycle: this.lifecycleState,
    });
    return this.cachedStoreSnapshot;
  }

  getServerSnapshot(): ConversationStoreSnapshot {
    return this.getSnapshot();
  }

  applyMutation(
    options: ConversationMutationOptions,
    mutation: (conversation: ConversationHistory) => ConversationHistory,
  ): ConversationMutationResult {
    this.assertOpen();
    if (options.expectedRevision !== this.controllerRevision) {
      const previous = this.current;
      this.emitConversationEvent(
        'mutation.rejected',
        this.buildEventDetail('mutation.rejected', previous, {
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options.actor ? { actor: options.actor } : {}),
          durability: options.durability ?? 'ephemeral',
          outcome: 'rejected',
          reason: 'revision-conflict',
        }),
      );
      return Object.freeze({
        accepted: false,
        revision: this.controllerRevision,
        reason: 'revision-conflict',
      });
    }
    this.commit(mutation(this.current), 'push', ['push'], {
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.durability ? { durability: options.durability } : {}),
    });
    return Object.freeze({ accepted: true, revision: this.controllerRevision });
  }

  reconcileExternalSnapshot(
    snapshot: ConversationStoreSnapshot,
    options: Omit<ConversationMutationOptions, 'expectedRevision'> = {},
  ): ConversationMutationResult {
    this.assertOpen();
    if (
      snapshot.conversation.id !== this.current.id ||
      snapshot.lifecycle !== 'open' ||
      snapshot.revision < 0 ||
      !Number.isSafeInteger(snapshot.revision)
    ) {
      const previous = this.current;
      this.emitConversationEvent(
        'mutation.rejected',
        this.buildEventDetail('mutation.rejected', previous, {
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options.actor ? { actor: options.actor } : {}),
          durability: 'external',
          outcome: 'rejected',
          reason: 'invalid-external-snapshot',
        }),
      );
      return Object.freeze({
        accepted: false,
        revision: this.controllerRevision,
        reason: 'invalid-external-snapshot',
      });
    }
    if (snapshot.revision !== this.controllerRevision + 1) {
      const previous = this.current;
      this.emitConversationEvent(
        'mutation.rejected',
        this.buildEventDetail('mutation.rejected', previous, {
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options.actor ? { actor: options.actor } : {}),
          durability: 'external',
          outcome: 'discarded',
          reason: 'stale-external-event',
        }),
      );
      return Object.freeze({
        accepted: false,
        revision: this.controllerRevision,
        reason: 'stale-external-event',
      });
    }
    this.commit(snapshot.conversation, 'push', ['push'], {
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      durability: 'external',
    });
    return Object.freeze({ accepted: true, revision: this.controllerRevision });
  }

  /** Monotonic revision for accepted controller state transitions. */
  get revision(): number {
    return this.controllerRevision;
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

  get plugins(): readonly MessagePluginIdentity[] {
    return this.pluginIdentityList;
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
    this.assertOpen();
    if (this.currentNode.parent) {
      const previousConversation = this.current;
      this.currentNode = this.currentNode.parent;
      this.controllerRevision += 1;
      this.emitConversationEvent('change', this.buildEventDetail('undo', previousConversation));
      this.emitConversationEvent('undo', this.buildEventDetail('undo', previousConversation));
      this.publishStoreSnapshot();
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
    this.assertOpen();
    const next = this.currentNode.children[childIndex];
    if (next) {
      const previousConversation = this.current;
      this.currentNode = next;
      this.controllerRevision += 1;
      this.emitConversationEvent('change', this.buildEventDetail('redo', previousConversation));
      this.emitConversationEvent('redo', this.buildEventDetail('redo', previousConversation));
      this.publishStoreSnapshot();
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
    this.assertOpen();
    if (this.currentNode.parent) {
      const target = this.currentNode.parent.children[index];
      if (target) {
        const previousConversation = this.current;
        this.currentNode = target;
        this.controllerRevision += 1;
        this.emitConversationEvent('change', this.buildEventDetail('switch', previousConversation));
        this.emitConversationEvent('switch', this.buildEventDetail('switch', previousConversation));
        this.publishStoreSnapshot();
        return this.current;
      }
    }
    return undefined;
  }

  fork(messageId?: string): Conversation {
    this.assertOpen();
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

    const forked = new Conversation(forkedHistory, this.environment);
    forked.forkLineage = {
      parentConversationId: this.current.id,
      ...(messageId ? { forkPointMessageId: messageId } : {}),
      sourceRevision: this.controllerRevision,
    };
    const detail = this.buildEventDetail('session.forked', previous, {
      childConversationId: forked.current.id,
      durability: 'snapshot',
    });
    this.emitConversationEvent('session.forked', detail);
    this.emitConversationEvent('change', detail);
    return forked;
  }

  tag(label: string): void {
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
    const previousConversation = this.current;
    const nextConversation = truncateFromPosition(this.current, position, options, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.removed',
      this.createChangeContext(previousConversation, nextConversation, 'messages.removed'),
    );
  }

  /**
   * Drops the message at `position` and everything after it — the branch-rewind
   * counterpart to {@link Conversation.truncateFromPosition}, which keeps the
   * opposite tail.
   */
  rewindBeforePosition(position: number, options?: RewindOptions): void {
    this.assertOpen();
    const previousConversation = this.current;
    const nextConversation = rewindBeforePosition(this.current, position, options, this.env);
    if (nextConversation === previousConversation) return;
    this.pushWithEvents(
      nextConversation,
      'messages.removed',
      this.createChangeContext(previousConversation, nextConversation, 'messages.removed'),
    );
  }

  /**
   * Drops `messageId` and everything after it. The id-keyed form of
   * {@link Conversation.rewindBeforePosition}, for edit flows that hold a
   * message id rather than a position. An unknown id is a no-op.
   */
  rewindBeforeMessage(messageId: string, options?: RewindOptions): void {
    this.assertOpen();
    const previousConversation = this.current;
    const nextConversation = rewindBeforeMessage(this.current, messageId, options, this.env);
    if (nextConversation === previousConversation) return;
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
    this.assertOpen();
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
    this.assertOpen();
    const previous = this.current;
    const startingRevision = this.controllerRevision;
    this.emitConversationEvent(
      'compaction.started',
      this.buildEventDetail('compaction.started', previous),
    );
    const operationSignal = options?.signal
      ? AbortSignal.any([this.operationAbortController.signal, options.signal])
      : this.operationAbortController.signal;
    const operation = compactConversation(
      this.current,
      summarizer,
      {
        ...options,
        signal: operationSignal,
      },
      this.env,
    );
    this.inFlightOperations.add(operation);
    let compacted;
    try {
      compacted = await operation;
    } catch (error) {
      const cancelled = operationSignal.aborted;
      if (this.lifecycleState === 'open') {
        this.emitConversationEvent(
          cancelled ? 'compaction.cancelled' : 'compaction.failed',
          this.buildEventDetail(
            cancelled ? 'compaction.cancelled' : 'compaction.failed',
            previous,
            { outcome: cancelled ? 'cancelled' : 'failed', reason: String(error) },
          ),
        );
      }
      if (cancelled) throw createOperationCancelledError(this.current.id, 'compaction');
      throw error;
    } finally {
      this.inFlightOperations.delete(operation);
    }
    if (this.lifecycleState !== 'open') {
      throw createOperationCancelledError(this.current.id, 'compaction');
    }
    if (this.controllerRevision !== startingRevision) {
      this.emitConversationEvent(
        'compaction.stale-discarded',
        this.buildEventDetail('compaction.stale-discarded', previous, {
          outcome: 'discarded',
          reason: 'revision-conflict',
        }),
      );
      throw createRevisionConflictError(this.current.id, startingRevision, this.controllerRevision);
    }
    const { conversation, result } = compacted;
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
    this.assertOpen();
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
   *
   * A message that is unknown or no longer streaming rejects the content (see
   * {@link updateStreamingMessage}); the rejection is a no-op all the way out,
   * so no history node is recorded and no event is emitted. Without that, a
   * post-stop token flood would add one undo entry and one round of events per
   * ignored token — and, under `maxHistoryDepth`, prune real ancestors to make
   * room for states that never differed.
   */
  updateStreamingMessage(messageId: string, content: string): void {
    this.assertOpen();
    const nextConversation = updateStreamingMessage(this.current, messageId, content, this.env);
    if (nextConversation === this.current) {
      return;
    }
    const streamSequence = (this.streamSequences.get(messageId) ?? 0) + 1;
    this.streamSequences.set(messageId, streamSequence);
    this.commit(
      nextConversation,
      'stream.updated',
      ['push', 'messages.updated', 'stream.updated'],
      {
        messageIds: [messageId],
        streamSequence,
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
    this.assertOpen();
    const nextConversation = finalizeStreamingMessage(this.current, messageId, options, this.env);
    this.commit(
      nextConversation,
      'stream.finalized',
      ['push', 'messages.updated', 'stream.finalized'],
      { messageIds: [messageId] },
    );
    this.streamSequences.delete(messageId);
  }

  /**
   * Cancels a streaming message by removing it from the conversation.
   */
  cancelStreamingMessage(messageId: string): void {
    this.assertOpen();
    const nextConversation = cancelStreamingMessage(this.current, messageId, this.env);
    this.commit(
      nextConversation,
      'stream.cancelled',
      ['push', 'messages.removed', 'stream.cancelled'],
      { messageIds: [messageId] },
    );
    this.streamSequences.delete(messageId);
  }

  appendToolCall(
    toolCall: AppendableToolCallInput,
    options?: Parameters<typeof appendToolCall>[2],
  ): void {
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
    const nextConversation = appendToolResult(this.current, toolResult, options, this.env);
    const context = this.createChangeContext(this.current, nextConversation, 'messages.appended');
    this.commit(
      nextConversation,
      'tool-results.appended',
      ['push', 'messages.appended', 'tool-results.appended'],
      context,
    );
  }

  /**
   * Replaces the tool-result message for `callId` with a new result, in
   * place. See {@link resolveToolResult} for the underlying primitive and
   * its identity/error semantics.
   */
  resolveToolResult(
    callId: string,
    toolResult: AppendableToolResult,
    options?: Parameters<typeof resolveToolResult>[3],
  ): void {
    this.assertOpen();
    const previousConversation = this.current;
    const nextConversation = resolveToolResult(this.current, callId, toolResult, options, this.env);
    this.pushWithEvents(
      nextConversation,
      'messages.updated',
      this.createChangeContext(previousConversation, nextConversation, 'messages.updated'),
    );
  }

  /**
   * Async counterpart to {@link Conversation.resolveToolResult}: collects a
   * streaming `toolResult` payload before replacing the pending result. See
   * {@link resolveToolResultAsync}.
   */
  async resolveToolResultAsync(
    callId: string,
    toolResult: AppendableToolResult,
    options?: Parameters<typeof resolveToolResultAsync>[3],
  ): Promise<void> {
    const previousConversation = this.current;
    const nextConversation = await this.runOwnedOperation(
      'resolveToolResultAsync',
      async (signal) =>
        resolveToolResultAsync(this.current, callId, toolResult, { ...options, signal }, this.env),
    );
    this.pushWithEvents(
      nextConversation,
      'messages.updated',
      this.createChangeContext(previousConversation, nextConversation, 'messages.updated'),
    );
  }

  appendToolResults(toolResults: ReadonlyArray<AppendableToolResult>): void {
    this.assertOpen();
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
    const nextConversation = await this.runOwnedOperation('appendToolResultAsync', async (signal) =>
      appendToolResultAsync(this.current, toolResult, { ...options, signal }, this.env),
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
    const nextConversation = await this.runOwnedOperation(
      'appendToolResultsAsync',
      async (signal) => appendToolResultsAsync(this.current, toolResults, this.env, signal),
    );
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
      OpenAIMessage[] | AnthropicConversation | GeminiConversation;
  }

  async appendProvider(
    provider: ConversationProvider,
    payload: OpenAIMessage[] | AnthropicConversation | GeminiConversation,
  ): Promise<void> {
    const adapter = await this.runOwnedOperation('appendProvider', async () =>
      loadConversationAdapter(provider),
    );
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
      id: node.id,
      revision: node.revision,
      parentId: node.parent?.id ?? null,
      conversation: node.conversation,
      children: node.children.map(serializeNode),
    });

    let root = this.currentNode;
    while (root.parent) {
      root = root.parent;
    }

    return finalizeSnapshot({
      snapshotFormatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
      conversationSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerRevision: this.controllerRevision,
      conversationId: this.current.id,
      currentBranchId: this.currentNode.id,
      root: serializeNode(root),
      currentPath: getPath(this.currentNode),
      createdAt: this.environment.now(),
      lineage: {
        ...this.forkLineage,
        retainedFloorNodeId: root.id,
        removedNodeIds: [...this.removedNodeIds].sort(),
      },
    });
  }

  /**
   * Reconstructs a Conversation instance from JSON.
   */
  static from(
    json: ConversationSnapshot,
    environment?: Partial<ConversationEnvironment>,
  ): Conversation {
    const snapshot = validateSnapshot(json);
    const rootConv = deserializeConversationHistory(snapshot.root.conversation);
    const conversation = new Conversation(rootConv, environment);
    conversation.controllerRevision = snapshot.controllerRevision;
    if (snapshot.lineage.parentConversationId && snapshot.lineage.sourceRevision !== undefined) {
      conversation.forkLineage = {
        parentConversationId: snapshot.lineage.parentConversationId,
        ...(snapshot.lineage.forkPointMessageId
          ? { forkPointMessageId: snapshot.lineage.forkPointMessageId }
          : {}),
        sourceRevision: snapshot.lineage.sourceRevision,
      };
    }
    // Recursive function to build the tree
    const buildTree = (
      nodeJSON: ConversationNodeSnapshot,
      parentNode: HistoryNode,
    ): HistoryNode => {
      const nodeConv = deserializeConversationHistory(nodeJSON.conversation);
      const node: HistoryNode = {
        id: nodeJSON.id,
        revision: nodeJSON.revision,
        conversation: nodeConv,
        parent: parentNode,
        children: [],
      };
      node.children = nodeJSON.children.map((child) => buildTree(child, node));
      return node;
    };

    const rootNode = conversation.currentNode;
    rootNode.id = snapshot.root.id;
    rootNode.revision = snapshot.root.revision;
    if (snapshot.root.parentId !== null) {
      throw createSerializationError('failed to restore snapshot: root parent must be null');
    }
    if (snapshot.lineage.retainedFloorNodeId !== rootNode.id) {
      throw createSerializationError(
        'failed to restore snapshot: retained floor identity mismatch',
      );
    }
    if (
      !Number.isSafeInteger(rootNode.revision) ||
      rootNode.revision < 0 ||
      rootNode.revision > snapshot.controllerRevision
    ) {
      throw createSerializationError(
        `failed to restore snapshot: invalid node revision ${rootNode.id}`,
      );
    }
    const seenIds = new Set<string>([rootNode.id]);
    const validateNode = (node: ConversationNodeSnapshot, expectedParentId: string): void => {
      if (seenIds.has(node.id))
        throw createSerializationError(`failed to restore snapshot: duplicate node id ${node.id}`);
      seenIds.add(node.id);
      if (node.parentId !== expectedParentId)
        throw createSerializationError(
          `failed to restore snapshot: inconsistent parent for ${node.id}`,
        );
      if (
        !Number.isSafeInteger(node.revision) ||
        node.revision < 0 ||
        node.revision > snapshot.controllerRevision
      ) {
        throw createSerializationError(
          `failed to restore snapshot: invalid node revision ${node.id}`,
        );
      }
      for (const child of node.children) validateNode(child, node.id);
    };
    for (const child of snapshot.root.children) validateNode(child, rootNode.id);
    for (const removedNodeId of snapshot.lineage.removedNodeIds) {
      if (seenIds.has(removedNodeId)) {
        throw createSerializationError(
          `failed to restore snapshot: removed node ${removedNodeId} is still retained`,
        );
      }
      conversation.removedNodeIds.add(removedNodeId);
    }
    rootNode.children = snapshot.root.children.map((child) => buildTree(child, rootNode));

    // Traverse to find the current node
    let current: HistoryNode = rootNode;
    for (const index of snapshot.currentPath) {
      const target = current.children[index];
      if (!target)
        throw createSerializationError(
          `failed to restore snapshot: current path index ${index} is out of range`,
        );
      current = target;
    }
    if (
      current.id !== snapshot.currentBranchId ||
      current.conversation.id !== snapshot.conversationId
    ) {
      throw createSerializationError('failed to restore snapshot: current identity mismatch');
    }
    conversation.currentNode = current;
    conversation.emitConversationEvent(
      'snapshot.restored',
      conversation.buildEventDetail('snapshot.restored', conversation.current, {
        durability: 'snapshot',
        outcome: 'completed',
      }),
    );

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
      this.assertOpen();
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
   * Aborts owned work, awaits quiescence, and releases subscriptions.
   */
  async dispose(): Promise<void> {
    if (this.lifecycleState === 'disposed') {
      await Promise.allSettled([...this.inFlightOperations]);
      return;
    }
    const previous = this.current;
    if (this.lifecycleState === 'open') {
      this.lifecycleState = 'disposed';
      this.operationAbortController.abort(
        createOperationCancelledError(this.current.id, 'operation'),
      );
      this.emitConversationEvent(
        'controller.disposed',
        this.buildEventDetail('controller.disposed', previous, {
          durability: 'snapshot',
          outcome: 'completed',
        }),
      );
      this.publishStoreSnapshot();
      this.emitter.complete();
    } else {
      this.lifecycleState = 'disposed';
      this.emitConversationEvent(
        'controller.disposed',
        this.buildEventDetail('controller.disposed', previous, {
          durability: 'snapshot',
          outcome: 'completed',
        }),
      );
      this.publishStoreSnapshot();
    }
    await Promise.allSettled([...this.inFlightOperations]);
    this.storeListeners.clear();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  [Symbol.dispose](): void {
    void this.dispose();
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
