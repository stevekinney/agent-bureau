import type { CompletableEventTarget, Observer, Subscription } from '@lostgradient/lifecycle';
import type { CompactionOptions, CompactionResult, Summarizer } from './compaction/types';
import type { ConversationEnvironment } from './environment';
import type {
  ConversationActionType,
  ConversationEventDetail,
  ConversationEventMap,
} from './events';
import type { ConversationMutationOptions, ConversationMutationResult } from './history';
import { createBindAction, type BindAction } from './history-bind';
import { compactOwned } from './history-compaction';
import type { ConversationChangeContext } from './history-events';
import { createExternalMutationActions } from './history-external-mutations';
import type { HistoryLifecycle } from './history-lifecycle';
import { createLifecycleActions } from './history-lifecycle-actions';
import { createMutationActions, type MutationActions } from './history-mutation-actions';
import { createObservationActions, createSubscriptionAction } from './history-observation';
import { createProviderActions, type ProviderActions } from './history-provider-actions';
import { createSnapshotAction, type SnapshotAction } from './history-snapshot';
import { createStreamingActions, type StreamingActions } from './history-streaming';
import { createToolActions, type ToolActions } from './history-tools';
import {
  createStoreActions,
  type ConversationStoreSnapshot,
  type HistoryTransaction,
  type StoreActions,
} from './history-transaction';
import { createTranscriptActions, type TranscriptActions } from './history-transcript';
import type { HistoryNode } from './history-tree';
import { createTreeActions, type TreeActions } from './history-tree-actions';
import type { ConversationHistory, MessagePlugin } from './types';

export type ConversationActions<T> = StoreActions &
  BindAction &
  SnapshotAction &
  TranscriptActions &
  ToolActions &
  MutationActions &
  ProviderActions &
  StreamingActions &
  TreeActions<T> & {
    readonly applyMutation: (
      options: ConversationMutationOptions,
      mutation: (conversation: ConversationHistory) => ConversationHistory,
    ) => ConversationMutationResult;
    readonly reconcileExternalSnapshot: (
      snapshot: ConversationStoreSnapshot,
      options?: Omit<ConversationMutationOptions, 'expectedRevision'>,
    ) => ConversationMutationResult;
    readonly addEventListener: CompletableEventTarget<ConversationEventMap>['addEventListener'];
    readonly removeEventListener: CompletableEventTarget<ConversationEventMap>['removeEventListener'];
    readonly dispatchEvent: CompletableEventTarget<ConversationEventMap>['dispatchEvent'];
    readonly watch: (run: (value: ConversationHistory) => void) => () => void;
    readonly on: CompletableEventTarget<ConversationEventMap>['on'];
    readonly once: CompletableEventTarget<ConversationEventMap>['once'];
    readonly toObservable: CompletableEventTarget<ConversationEventMap>['toObservable'];
    readonly events: CompletableEventTarget<ConversationEventMap>['events'];
    readonly subscribe: {
      (onStoreChange: () => void): () => void;
      <K extends keyof ConversationEventMap & string>(
        type: K,
        observerOrNext?:
          Observer<ConversationEventMap[K]> | ((value: ConversationEventMap[K]) => void),
        error?: (err: unknown) => void,
        complete?: () => void,
      ): Subscription;
    };
    readonly compact: (
      summarizer: Summarizer,
      options?: CompactionOptions,
    ) => Promise<CompactionResult>;
    readonly close: () => void;
    readonly complete: () => void;
    readonly dispose: () => Promise<void>;
  };

export type CompositionHooks<T> = {
  readonly transaction: HistoryTransaction;
  readonly lifecycle: HistoryLifecycle;
  readonly emitter: CompletableEventTarget<ConversationEventMap>;
  readonly current: () => ConversationHistory;
  readonly node: () => HistoryNode;
  readonly lineage: () => {
    parentConversationId?: string;
    forkPointMessageId?: string;
    sourceRevision?: number;
  };
  readonly removedNodeIds: () => readonly string[];
  readonly revision: () => number;
  readonly environment: ConversationEnvironment;
  readonly sourcePlugins: readonly MessagePlugin[];
  readonly assertOpen: () => void;
  readonly commit: (
    next: ConversationHistory,
    action: ConversationActionType,
    events: readonly ConversationActionType[],
    context?: ConversationChangeContext,
  ) => void;
  readonly changeContext: (
    previous: ConversationHistory,
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
  ) => ConversationChangeContext;
  readonly detail: (
    action: ConversationActionType,
    previous: ConversationHistory,
    context?: ConversationChangeContext,
  ) => ConversationEventDetail;
  readonly emit: (type: string, detail: ConversationEventDetail) => void;
  readonly create: (history: ConversationHistory, environment: ConversationEnvironment) => T;
  readonly setLineage: (
    conversation: T,
    lineage: { parentConversationId: string; forkPointMessageId?: string; sourceRevision: number },
  ) => void;
};

export function composeConversationActions<T>(hooks: CompositionHooks<T>): ConversationActions<T> {
  const store = createStoreActions(hooks.transaction, () => hooks.lifecycle.state);
  const snapshot = createSnapshotAction({
    currentNode: hooks.node,
    revision: hooks.revision,
    environment: hooks.environment,
    lineage: hooks.lineage,
    removedNodeIds: hooks.removedNodeIds,
  });
  const bind = createBindAction(
    hooks.current,
    () => hooks.environment,
    hooks.assertOpen,
    (history) => hooks.commit(history, 'push', ['push']),
  );
  const transcript = createTranscriptActions(hooks.current, () => hooks.environment);
  const streaming = createStreamingActions(
    hooks.current,
    hooks.environment,
    hooks.assertOpen,
    hooks.commit,
  );
  const tools = createToolActions({
    current: hooks.current,
    environment: hooks.environment,
    assertOpen: hooks.assertOpen,
    commit: hooks.commit,
    runOwned: (name, operation) =>
      hooks.lifecycle.runOwnedOperation(
        name,
        hooks.current().id,
        hooks.revision(),
        hooks.revision,
        operation,
      ),
    context: hooks.changeContext,
  });
  const mutations = createMutationActions({
    current: hooks.current,
    environment: hooks.environment,
    assertOpen: hooks.assertOpen,
    createChangeContext: hooks.changeContext,
    pushWithEvents: (next, action, context) =>
      hooks.commit(next, action, ['push', action], context),
  });
  const external = createExternalMutationActions({
    current: hooks.current,
    revision: hooks.revision,
    assertOpen: hooks.assertOpen,
    detail: hooks.detail,
    emit: (type, detail) => hooks.emit(type, detail),
    commit: (next, context) => hooks.commit(next, 'push', ['push'], context),
  });
  const providers = createProviderActions({
    current: hooks.current,
    environment: hooks.environment,
    runOwned: (name, operation) =>
      hooks.lifecycle.runOwnedOperation(
        name,
        hooks.current().id,
        hooks.revision(),
        hooks.revision,
        operation,
      ),
    commit: (next, action, context) => hooks.commit(next, action, ['push', action], context),
  });
  const tree = createTreeActions<T>({
    current: hooks.current,
    node: hooks.node,
    revision: hooks.revision,
    environment: hooks.environment,
    sourcePlugins: hooks.sourcePlugins,
    assertOpen: hooks.assertOpen,
    navigate: (action, index) =>
      hooks.transaction.navigate(action, index, hooks.lifecycle.state, (type, detail) =>
        hooks.emit(type, detail),
      ),
    commit: (next, action, events) => hooks.commit(next, action, events),
    detail: (action, previous, context) => hooks.detail(action, previous, context),
    emit: hooks.emit,
    create: hooks.create,
    setLineage: hooks.setLineage,
  });
  const observation = createObservationActions({ emitter: hooks.emitter, current: hooks.current });
  const subscribe = createSubscriptionAction(
    hooks.emitter,
    hooks.transaction,
    () => hooks.lifecycle.state,
  );
  const lifecycle = createLifecycleActions({
    lifecycle: hooks.lifecycle,
    transaction: hooks.transaction,
    current: hooks.current,
    buildDetail: hooks.detail,
    emit: (type, detail) => hooks.emit(type, detail),
  });
  const compact = async (
    summarizer: Summarizer,
    options?: CompactionOptions,
  ): Promise<CompactionResult> => {
    hooks.assertOpen();
    return compactOwned(summarizer, options, hooks.environment, {
      signal: hooks.lifecycle.signal,
      lifecycle: () => hooks.lifecycle.state,
      revision: hooks.revision,
      current: hooks.current,
      track: (operation) => hooks.lifecycle.track(operation),
      untrack: (operation) => hooks.lifecycle.untrack(operation),
      event: (type, detail) => hooks.emit(type, detail),
      detail: hooks.detail,
      commit: (conversation, previous) =>
        hooks.commit(conversation, 'compaction.completed', ['push', 'compaction.completed'], {
          ...hooks.changeContext(previous, conversation, 'messages.removed'),
          outcome: 'completed',
        }),
    });
  };
  const dispose = async (): Promise<void> => {
    await lifecycle.dispose();
    hooks.emitter.complete();
    hooks.transaction.clearSubscriptions();
  };
  return {
    ...store,
    ...snapshot,
    ...bind,
    ...transcript,
    ...streaming,
    ...tools,
    ...mutations,
    ...external,
    ...providers,
    ...tree,
    ...observation,
    ...lifecycle,
    subscribe,
    compact,
    dispose,
  };
}
