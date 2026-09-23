import { deserializeConversationHistory } from './conversation/index';
import type { ConversationHistory, ConversationNodeSnapshot } from './types';

export interface HistoryNode {
  id: string;
  revision: number;
  conversation: ConversationHistory;
  parent: HistoryNode | null;
  children: HistoryNode[];
}

export function getHistoryNodePath(node: HistoryNode): number[] {
  const path: number[] = [];
  let current = node;
  while (current.parent) {
    path.unshift(current.parent.children.indexOf(current));
    current = current.parent;
  }
  return path;
}

export function serializeHistoryNode(node: HistoryNode): ConversationNodeSnapshot {
  return {
    id: node.id,
    revision: node.revision,
    parentId: node.parent?.id ?? null,
    conversation: node.conversation,
    children: node.children.map(serializeHistoryNode),
  };
}

export function restoreHistoryChildren(
  snapshots: readonly ConversationNodeSnapshot[],
  parent: HistoryNode,
): HistoryNode[] {
  return snapshots.map((snapshot) => {
    const node: HistoryNode = {
      id: snapshot.id,
      revision: snapshot.revision,
      conversation: deserializeConversationHistory(snapshot.conversation),
      parent,
      children: [],
    };
    node.children = restoreHistoryChildren(snapshot.children, node);
    return node;
  });
}

export function pruneHistoryToDepth(
  currentNode: HistoryNode,
  maxDepth: number,
  removedNodeIds: Set<string>,
): boolean {
  let depth = 0;
  let node: HistoryNode | null = currentNode;
  while (node) {
    depth++;
    node = node.parent;
  }

  let pruned = false;
  while (depth > maxDepth) {
    let root = currentNode;
    while (root.parent) root = root.parent;

    const childOnPath = root.children.find((child) => {
      let current: HistoryNode | null = currentNode;
      while (current) {
        if (current === child) return true;
        current = current.parent;
      }
      return false;
    });
    if (!childOnPath) break;

    const collectRemoved = (candidate: HistoryNode): void => {
      removedNodeIds.add(candidate.id);
      for (const child of candidate.children) collectRemoved(child);
    };
    removedNodeIds.add(root.id);
    for (const discardedChild of root.children) {
      if (discardedChild !== childOnPath) collectRemoved(discardedChild);
    }

    childOnPath.parent = null;
    depth--;
    pruned = true;
  }
  return pruned;
}
