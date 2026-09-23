import { deserializeConversationHistory } from './conversation/index';
import { validateSnapshot } from './conversation/snapshot-integrity';
import type { ConversationEnvironment } from './environment';
import { createSerializationError } from './errors';
import type { HistoryNode } from './history-tree';
import { restoreHistoryChildren } from './history-tree';
import type { ConversationHistory, ConversationSnapshot } from './types';

type RestoreTarget<T> = {
  readonly currentNode: () => HistoryNode;
  readonly setState: (revision: number, node: HistoryNode) => void;
  readonly setRemovedNodeIds: (ids: readonly string[]) => void;
  readonly setCurrentNode: (node: HistoryNode) => void;
  readonly setLineage: (lineage: {
    parentConversationId: string;
    forkPointMessageId?: string;
    sourceRevision: number;
  }) => void;
  readonly lifecycle: () => string;
  readonly emitRestored: () => void;
  readonly create: (
    history: ConversationHistory,
    environment?: Partial<ConversationEnvironment>,
  ) => T;
};

export function restoreConversation<T>(
  json: ConversationSnapshot,
  environment: Partial<ConversationEnvironment> | undefined,
  target: RestoreTarget<T>,
): T {
  const snapshot = validateSnapshot(json);
  const conversation = target.create(
    deserializeConversationHistory(snapshot.root.conversation),
    environment,
  );
  if (snapshot.lineage.parentConversationId && snapshot.lineage.sourceRevision !== undefined) {
    target.setLineage({
      parentConversationId: snapshot.lineage.parentConversationId,
      ...(snapshot.lineage.forkPointMessageId
        ? { forkPointMessageId: snapshot.lineage.forkPointMessageId }
        : {}),
      sourceRevision: snapshot.lineage.sourceRevision,
    });
  }
  const rootNode = target.currentNode();
  target.setState(snapshot.controllerRevision, rootNode);
  rootNode.id = snapshot.root.id;
  rootNode.revision = snapshot.root.revision;
  target.setRemovedNodeIds(snapshot.lineage.removedNodeIds);
  rootNode.children = restoreHistoryChildren(snapshot.root.children, rootNode);
  let current = rootNode;
  for (const index of snapshot.currentPath) {
    const next = current.children[index];
    if (!next) throw createSerializationError('failed to restore snapshot: invalid current path');
    current = next;
  }
  target.setCurrentNode(current);
  queueMicrotask(() => {
    if (target.lifecycle() === 'open') target.emitRestored();
  });
  return conversation;
}

export function restoreWithController<T>(
  json: ConversationSnapshot,
  environment: Partial<ConversationEnvironment> | undefined,
  create: (history: ConversationHistory, environment?: Partial<ConversationEnvironment>) => T,
  controller: (getConversation: () => T) => Omit<RestoreTarget<T>, 'create'>,
): T {
  let conversation: T | undefined;
  const getConversation = (): T => {
    if (!conversation) throw new Error('Conversation restore was not initialized');
    return conversation;
  };
  return restoreConversation(json, environment, {
    ...controller(getConversation),
    create: (history, childEnvironment) => {
      conversation = create(history, childEnvironment);
      return conversation;
    },
  });
}
