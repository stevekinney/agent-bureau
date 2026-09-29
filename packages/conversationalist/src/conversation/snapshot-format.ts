/**
 * Dispatch between supported snapshot format versions. Version 2 is current;
 * version 1 is decoded through its own validator and the explicit migration in
 * `snapshot-v1.ts`.
 */
import type { ConversationHistory } from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import {
  readSnapshotFormatVersion,
  snapshotError,
  unsupportedSnapshotFormatVersion,
} from './snapshot-integrity';
import { decodeSnapshotV1 } from './snapshot-v1';
import {
  currentConversationFromSnapshotV2,
  type DecodedSnapshot,
  decodeSnapshotV2,
} from './snapshot-v2';
import {
  currentConversationFromNestedSnapshotV2,
  decodeNestedSnapshotV2,
} from './snapshot-v2-nested';

export function decodeSnapshot(value: unknown): DecodedSnapshot {
  const version = readSnapshotFormatVersion(value);
  if (version === 1) return decodeSnapshotV1(value);
  if (version === 2) {
    rejectMixedV2(value);
    return isNestedV2(value) ? decodeNestedSnapshotV2(value) : decodeSnapshotV2(value);
  }
  throw unsupportedSnapshotFormatVersion(version);
}

/**
 * The current branch's conversation from a snapshot of any supported version,
 * validated, without restoring a `Conversation`. For a version 2 snapshot this
 * reads only the nodes on the current path.
 */
export function currentConversationFromSnapshot(value: unknown): ConversationHistory {
  const version = readSnapshotFormatVersion(value);
  if (version === 2) {
    rejectMixedV2(value);
    return isNestedV2(value)
      ? currentConversationFromNestedSnapshotV2(value)
      : currentConversationFromSnapshotV2(value);
  }
  if (version !== 1) throw unsupportedSnapshotFormatVersion(version);
  const decoded = decodeSnapshotV1(value);
  let current = decoded.root;
  for (const index of decoded.currentPath) current = current.children[index]!;
  return deepFreeze(current.conversation);
}

function isNestedV2(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'root' in value &&
    !('nodes' in value)
  );
}

function rejectMixedV2(value: unknown): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'root' in value &&
    'nodes' in value
  ) {
    throw snapshotError('ambiguous version 2 snapshot shape');
  }
}
