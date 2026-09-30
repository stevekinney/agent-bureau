import { ensureConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { createConversationLifecycleError } from './errors';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventType,
} from './events';
import {
  buildConversationEventDetail,
  compactionCorrelationId,
  type ConversationChangeContext,
} from './history-events';
import type { HistoryNode } from './history-tree';
import { pruneHistoryToDepth } from './history-tree';
import type { ConversationHistory, MessagePluginIdentity } from './types';
import { cloneSharingFrozen } from './utilities/type-helpers';

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
    state: { readonly conversation: ConversationHistory; readonly revision: number } = {
      conversation: this.current,
      revision: this.controllerRevision,
    },
  ): ConversationEventDetail {
    return this.buildEventDetailFor(
      action,
      state.conversation,
      state.revision,
      previousConversation,
      context,
    );
  }

  /** Builds a detail for a captured state, assigning the next sequence at call time. */
  buildEventDetailFor(
    action: ConversationActionType,
    current: ConversationHistory,
    revision: number,
    previousConversation: ConversationHistory,
    context: ConversationChangeContext = {},
  ): ConversationEventDetail {
    this.eventSequenceValue += 1;
    return buildConversationEventDetail(
      action,
      current,
      previousConversation,
      context,
      revision,
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
    const safeNext = ensureConversationSafe(cloneSharingFrozen(next));
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

    // Listeners can write reentrantly while events are emitted below, so every
    // event of this commit describes the state this commit produced.
    const committed = { conversation: safeNext, revision: this.controllerRevision };
    const pruned =
      hooks.environment.maxHistoryDepth !== undefined &&
      pruneHistoryToDepth(this.currentNode, hooks.environment.maxHistoryDepth, this.removedNodeIds);
    if (pruned) {
      hooks.emit(
        'branch.pruned',
        this.buildEventDetail(
          'branch.pruned',
          previousConversation,
          { durability: 'snapshot', outcome: 'completed' },
          committed,
        ),
      );
    }
    for (const identity of hooks.takePendingPluginActivations()) {
      hooks.emit(
        'plugin.activated',
        this.buildEventDetail(
          'plugin.activated',
          previousConversation,
          { outcome: 'completed', plugin: identity },
          committed,
        ),
      );
    }
    const eventContext = {
      ...context,
      correlationId:
        context?.correlationId ??
        (context?.compaction
          ? compactionCorrelationId(previousConversation.id, context.compaction.attemptId)
          : `${safeNext.id}:revision:${committed.revision}`),
    };
    hooks.emit(
      'change',
      this.buildEventDetail(changeAction, previousConversation, eventContext, committed),
    );
    for (const eventType of emittedEvents) {
      hooks.emit(
        eventType,
        this.buildEventDetail(eventType, previousConversation, eventContext, committed),
      );
    }
    this.publishStoreSnapshot();
  }

  /**
   * Compare-and-swap over the controller revision: commits `next` only while
   * the revision still equals `expectedRevision`, and otherwise returns
   * `false` having changed nothing — no node, no revision, no event. A match
   * commits exactly as {@link commit} does, lifecycle check included.
   *
   * The comparison and the commit run in one synchronous step, so no other
   * write can land between them.
   */
  commitAtRevision(
    expectedRevision: number,
    next: ConversationHistory,
    changeAction: ConversationActionType,
    emittedEvents: readonly ConversationActionType[],
    context: ConversationChangeContext | undefined,
    lifecycle: ConversationLifecycle,
    hooks: HistoryTransactionHooks,
  ): boolean {
    if (this.controllerRevision !== expectedRevision) return false;
    this.commit(next, changeAction, emittedEvents, context, lifecycle, hooks);
    return true;
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
    // The conversation can close between getSnapshot() and subscribe(); a
    // disposed store never publishes again, so there is nothing to subscribe
    // to. A closed store still publishes once more, on dispose, so register.
    if (lifecycle === 'disposed') return () => {};
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
    const cached = this.cachedStoreSnapshot;
    if (
      cached &&
      cached.conversation === this.current &&
      cached.revision === this.controllerRevision &&
      cached.lifecycle === lifecycle
    ) {
      return cached;
    }
    this.cachedStoreSnapshot = Object.freeze({
      conversation: this.current,
      revision: this.controllerRevision,
      lifecycle,
    });
    return this.cachedStoreSnapshot;
  }

  publishStoreSnapshot(): void {
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
