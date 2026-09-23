import { ensureConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { createConversationLifecycleError } from './errors';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventType,
} from './events';
import { buildConversationEventDetail, type ConversationChangeContext } from './history-events';
import type { HistoryNode } from './history-tree';
import { pruneHistoryToDepth } from './history-tree';
import type { ConversationHistory, MessagePluginIdentity } from './types';

export type ConversationLifecycle = 'open' | 'closed' | 'disposed';

export interface ConversationStoreSnapshot {
  readonly conversation: ConversationHistory;
  readonly revision: number;
  readonly lifecycle: ConversationLifecycle;
}

export type HistoryTransactionHooks = {
  readonly environment: Pick<ConversationEnvironment, 'maxHistoryDepth'>;
  readonly takePendingPluginActivations: () => readonly MessagePluginIdentity[];
  readonly emit: (type: ConversationEventType, detail: ConversationEventDetail) => void;
};

/** Owns mutable history state and the ordered transaction/publication protocol. */
export class HistoryTransaction {
  private currentNode: HistoryNode;
  private controllerRevision = 0;
  private readonly removedNodeIds = new Set<string>();
  private cachedStoreSnapshot: ConversationStoreSnapshot | undefined;

  constructor(initial: ConversationHistory) {
    this.currentNode = {
      id: `${initial.id}:0`,
      revision: 0,
      conversation: initial,
      parent: null,
      children: [],
    };
  }

  get current(): ConversationHistory {
    return this.currentNode.conversation;
  }

  get node(): HistoryNode {
    return this.currentNode;
  }

  get revision(): number {
    return this.controllerRevision;
  }

  private eventSequenceValue = 0;

  private readonly storeListenersValue = new Set<{ notify: () => void }>();

  setCurrentNode(node: HistoryNode): void {
    this.currentNode = node;
  }

  setRevision(revision: number): void {
    this.controllerRevision = revision;
  }

  getRemovedNodeIds(): readonly string[] {
    return [...this.removedNodeIds];
  }

  setRestoredState(revision: number, node: HistoryNode): void {
    this.controllerRevision = revision;
    this.currentNode = node;
  }

  setRemovedNodeIds(ids: readonly string[]): void {
    this.removedNodeIds.clear();
    for (const id of ids) this.removedNodeIds.add(id);
  }

  assertOpen(lifecycle: ConversationLifecycle): void {
    if (lifecycle !== 'open') {
      throw createConversationLifecycleError(this.current.id, lifecycle);
    }
  }

  buildEventDetail(
    action: ConversationActionType,
    previousConversation: ConversationHistory,
    context: ConversationChangeContext = {},
  ): ConversationEventDetail {
    this.cachedStoreSnapshot = undefined;
    this.eventSequenceValue += 1;
    return buildConversationEventDetail(
      action,
      this.current,
      previousConversation,
      context,
      this.controllerRevision,
      this.eventSequenceValue,
    );
  }

  commit(
    next: ConversationHistory,
    changeAction: ConversationActionType,
    emittedEvents: readonly ConversationActionType[],
    context: ConversationChangeContext | undefined,
    lifecycle: ConversationLifecycle,
    hooks: HistoryTransactionHooks,
  ): void {
    this.assertOpen(lifecycle);
    const previousConversation = this.current;
    const safeNext = ensureConversationSafe(structuredClone(next));
    this.controllerRevision += 1;
    const newNode: HistoryNode = {
      id: `${safeNext.id}:${this.controllerRevision}`,
      revision: this.controllerRevision,
      conversation: safeNext,
      parent: this.currentNode,
      children: [],
    };
    this.currentNode.children.push(newNode);
    this.currentNode = newNode;

    const pruned =
      hooks.environment.maxHistoryDepth !== undefined &&
      pruneHistoryToDepth(this.currentNode, hooks.environment.maxHistoryDepth, this.removedNodeIds);
    if (pruned) {
      hooks.emit(
        'branch.pruned',
        this.buildEventDetail('branch.pruned', previousConversation, {
          durability: 'snapshot',
          outcome: 'completed',
        }),
      );
    }
    for (const identity of hooks.takePendingPluginActivations()) {
      hooks.emit(
        'plugin.activated',
        this.buildEventDetail('plugin.activated', previousConversation, {
          outcome: 'completed',
          plugin: identity,
        }),
      );
    }
    const eventContext = {
      ...context,
      correlationId:
        context?.correlationId ?? `${this.current.id}:revision:${this.controllerRevision}`,
    };
    hooks.emit('change', this.buildEventDetail(changeAction, previousConversation, eventContext));
    for (const eventType of emittedEvents) {
      hooks.emit(eventType, this.buildEventDetail(eventType, previousConversation, eventContext));
    }
    this.publishStoreSnapshot();
  }

  navigate(
    action: 'undo' | 'redo' | 'switch',
    index: number,
    lifecycle: ConversationLifecycle,
    emit: (type: ConversationEventType, detail: ConversationEventDetail) => void,
  ): ConversationHistory | undefined {
    this.assertOpen(lifecycle);
    const target =
      action === 'undo'
        ? this.currentNode.parent
        : action === 'redo'
          ? this.currentNode.children[index]
          : this.currentNode.parent?.children[index];
    if (!target) return undefined;
    const previous = this.current;
    this.currentNode = target;
    this.controllerRevision += 1;
    const correlationId = `${this.current.id}:revision:${this.controllerRevision}`;
    const detail = this.buildEventDetail(action, previous, { correlationId });
    emit('change', detail);
    emit(action, this.buildEventDetail(action, previous, { correlationId }));
    this.publishStoreSnapshot();
    return this.current;
  }

  subscribe(notify: () => void, lifecycle: ConversationLifecycle): () => void {
    this.assertOpen(lifecycle);
    const subscription = { notify };
    this.storeListenersValue.add(subscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.storeListenersValue.delete(subscription);
    };
  }

  getSnapshot(lifecycle: ConversationLifecycle): ConversationStoreSnapshot {
    this.cachedStoreSnapshot ??= Object.freeze({
      conversation: this.current,
      revision: this.controllerRevision,
      lifecycle,
    });
    return this.cachedStoreSnapshot;
  }

  publishStoreSnapshot(): void {
    this.cachedStoreSnapshot = undefined;
    for (const subscription of Array.from(this.storeListenersValue)) subscription.notify();
  }

  clearSubscriptions(): void {
    this.storeListenersValue.clear();
  }
}

export type StoreActions = {
  readonly getSnapshot: () => ConversationStoreSnapshot;
  readonly getServerSnapshot: () => ConversationStoreSnapshot;
};

export function createStoreActions(
  transaction: HistoryTransaction,
  lifecycle: () => ConversationLifecycle,
): StoreActions {
  return {
    getSnapshot: () => transaction.getSnapshot(lifecycle()),
    getServerSnapshot: () => transaction.getSnapshot(lifecycle()),
  };
}
