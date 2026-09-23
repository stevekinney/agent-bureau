import {
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  finalizeSnapshot,
} from './conversation/snapshot-integrity';
import type { ConversationEnvironment } from './environment';
import type { HistoryNode } from './history-tree';
import { getHistoryNodePath, serializeHistoryNode } from './history-tree';
import type { ConversationSnapshot } from './types';
import { CURRENT_SCHEMA_VERSION } from './types';

export function createSnapshot(
  currentNode: HistoryNode,
  revision: number,
  environment: ConversationEnvironment,
  lineage: { parentConversationId?: string; forkPointMessageId?: string; sourceRevision?: number },
  removedNodeIds: readonly string[],
): ConversationSnapshot {
  let root = currentNode;
  while (root.parent) root = root.parent;
  return finalizeSnapshot({
    snapshotFormatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
    conversationSchemaVersion: CURRENT_SCHEMA_VERSION,
    controllerRevision: revision,
    conversationId: currentNode.conversation.id,
    currentBranchId: currentNode.id,
    root: serializeHistoryNode(root),
    currentPath: getHistoryNodePath(currentNode),
    createdAt: environment.now(),
    lineage: {
      ...lineage,
      retainedFloorNodeId: root.id,
      removedNodeIds: [...removedNodeIds].toSorted(),
    },
  });
}

export type SnapshotAction = {
  readonly snapshot: () => ConversationSnapshot;
};

export function createSnapshotAction(hooks: {
  readonly currentNode: () => HistoryNode;
  readonly revision: () => number;
  readonly environment: ConversationEnvironment;
  readonly lineage: () => {
    parentConversationId?: string;
    forkPointMessageId?: string;
    sourceRevision?: number;
  };
  readonly removedNodeIds: () => readonly string[];
}): SnapshotAction {
  return {
    snapshot: () =>
      createSnapshot(
        hooks.currentNode(),
        hooks.revision(),
        hooks.environment,
        hooks.lineage(),
        hooks.removedNodeIds(),
      ),
  };
}
