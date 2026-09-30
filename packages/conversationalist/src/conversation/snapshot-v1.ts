/**
 * Snapshot format version 1, kept only to read snapshots already at rest
 * (durable checkpoints, replayed workflow memos). `validateSnapshotV1` is the
 * original validator, unchanged, so a v1 digest verifies exactly as it did
 * when it was written. `migrateConversationSnapshotV1` is the explicit,
 * version-pinned migration to version 2 that `Conversation.from()` routes a
 * v1 snapshot through.
 */
import { conversationSchema } from '../schemas';
import type {
  ConversationHistory,
  ConversationNodeSnapshotV1,
  ConversationSnapshot,
  ConversationSnapshotV1,
  Message,
} from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import { deserializeConversationHistory } from './serialization';
import {
  asRecord,
  assertLineageMatchesTree,
  readRevision,
  readSnapshotEnvelope,
  readString,
  snapshotDigest,
  snapshotError,
  stableStringify,
  unsupportedSnapshotFormatVersion,
} from './snapshot-integrity';
import { type DecodedSnapshot, type DecodedSnapshotNode, encodeSnapshot } from './snapshot-v2';

export function validateSnapshotV1(value: unknown): ConversationSnapshotV1 {
  const envelope = readSnapshotEnvelope(value);
  if (envelope.snapshotFormatVersion !== 1) {
    throw unsupportedSnapshotFormatVersion(envelope.snapshotFormatVersion);
  }
  const seenIds = new Set<string>();
  const root = readNode(
    envelope.record['root'],
    envelope.conversationSchemaVersion,
    envelope.controllerRevision,
    null,
    seenIds,
  );
  assertLineageMatchesTree(envelope.lineage, root.id, seenIds);
  const currentNode = resolvePath(root, envelope.currentPath);
  if (
    currentNode.id !== envelope.currentBranchId ||
    currentNode.conversation.id !== envelope.conversationId
  ) {
    throw snapshotError('current identity mismatch');
  }
  const snapshot: ConversationSnapshotV1 = {
    snapshotFormatVersion: 1,
    conversationSchemaVersion: envelope.conversationSchemaVersion,
    controllerRevision: envelope.controllerRevision,
    conversationId: envelope.conversationId,
    currentBranchId: envelope.currentBranchId,
    root,
    currentPath: envelope.currentPath,
    createdAt: envelope.createdAt,
    lineage: envelope.lineage,
    integrity: envelope.integrity,
  };
  const { integrity: unsignedIntegrity, ...unsigned } = snapshot;
  if (unsignedIntegrity.digest !== snapshotDigest(unsigned)) {
    throw snapshotError('integrity digest mismatch');
  }
  return snapshot;
}

/**
 * Version 1 deserialized every node independently, so no two nodes share a
 * message instance. Reuse the parent's instance wherever the message is
 * unchanged, so re-encoding as version 2 stores it once.
 */
function shareUnchangedMessages(
  parent: ConversationHistory | null,
  conversation: ConversationHistory,
): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const id of conversation.ids) {
    const message = conversation.messages[id]!;
    const parentMessage = parent?.messages[id];
    messages[id] =
      parentMessage !== undefined && stableStringify(parentMessage) === stableStringify(message)
        ? parentMessage
        : message;
  }
  return deepFreeze({ ...conversation, messages });
}

function decodeNodeV1(
  node: ConversationNodeSnapshotV1,
  parent: ConversationHistory | null,
): DecodedSnapshotNode {
  const conversation = shareUnchangedMessages(
    parent,
    deserializeConversationHistory(node.conversation),
  );
  return {
    id: node.id,
    revision: node.revision,
    conversation,
    children: node.children.map((child) => decodeNodeV1(child, conversation)),
  };
}

export function decodeSnapshotV1(value: unknown): DecodedSnapshot {
  const snapshot = validateSnapshotV1(value);
  return {
    conversationSchemaVersion: snapshot.conversationSchemaVersion,
    controllerRevision: snapshot.controllerRevision,
    conversationId: snapshot.conversationId,
    currentBranchId: snapshot.currentBranchId,
    createdAt: snapshot.createdAt,
    currentPath: snapshot.currentPath,
    lineage: snapshot.lineage,
    streamSequences: {},
    root: decodeNodeV1(snapshot.root, null),
  };
}

/**
 * Migrate a version 1 snapshot to version 2. Validates the v1 envelope and
 * digest first, then re-encodes the same tree, revision, creation time, and
 * lineage under a fresh version 2 digest.
 */
export function migrateConversationSnapshotV1(value: unknown): ConversationSnapshot {
  return encodeSnapshot(decodeSnapshotV1(value));
}

function readNode(
  value: unknown,
  schemaVersion: number,
  controllerRevision: number,
  expectedParentId: string | null,
  seenIds: Set<string>,
): ConversationNodeSnapshotV1 {
  const node = asRecord(value, 'node');
  const id = readString(node, 'id', 'node');
  const revision = readRevision(node, 'revision', 'node');
  if (seenIds.has(id)) throw snapshotError(`duplicate node id ${id}`);
  if (revision > controllerRevision) throw snapshotError(`invalid node revision ${id}`);
  const parentId = node['parentId'];
  if (parentId !== null && typeof parentId !== 'string') throw snapshotError('invalid node');
  if (parentId !== expectedParentId) throw snapshotError(`inconsistent parent for ${id}`);
  const parsedConversation = conversationSchema.safeParse(node['conversation']);
  if (!parsedConversation.success || parsedConversation.data.schemaVersion !== schemaVersion) {
    throw snapshotError('node conversation schema version mismatch');
  }
  const children = node['children'];
  if (!Array.isArray(children)) throw snapshotError('invalid node');
  seenIds.add(id);
  return {
    id,
    revision,
    parentId,
    conversation: parsedConversation.data,
    children: children.map((child) =>
      readNode(child, schemaVersion, controllerRevision, id, seenIds),
    ),
  };
}

function resolvePath(
  root: ConversationNodeSnapshotV1,
  path: readonly number[],
): ConversationNodeSnapshotV1 {
  let current = root;
  for (const index of path) {
    const child = current.children[index];
    if (!child) throw snapshotError(`current path index ${index} is out of range`);
    current = child;
  }
  return current;
}
