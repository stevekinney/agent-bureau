import type { DecodedSnapshotNode } from './conversation/snapshot-v2';
import type { ConversationHistory } from './types';

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

/**
 * Rebuild live history nodes from a decoded snapshot; conversations are
 * already validated and frozen. Iterative, because history is one level per
 * commit and a long conversation's tree is too deep to recurse through.
 */
export function buildHistoryChildren(
  decoded: readonly DecodedSnapshotNode[],
  parent: HistoryNode,
): HistoryNode[] {
  const pending: Array<[readonly DecodedSnapshotNode[], HistoryNode]> = [[decoded, parent]];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [children, owner] = entry;
    owner.children = children.map((child) => {
      const node: HistoryNode = {
        id: child.id,
        revision: child.revision,
        conversation: child.conversation,
        parent: owner,
        children: [],
      };
      pending.push([child.children, node]);
      return node;
    });
  }
  return parent.children;
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
