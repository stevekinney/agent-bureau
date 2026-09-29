/**
 * Reads the nested format-2 snapshots published by conversationalist 1.3.1.
 * Current format-2 snapshots use flat nodes under the same version number, so
 * snapshot-format.ts selects this decoder when the envelope has a root tree.
 * Full restoration walks that tree iteratively; current-conversation reads
 * follow only the selected path.
 */
import type { ConversationHistory, Message } from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import {
  assertLineageMatchesTree,
  assertSnapshotDigest,
  readSnapshotEnvelope,
  snapshotError,
  type SnapshotEnvelope,
} from './snapshot-integrity';
import {
  deserializeNodeConversation,
  readNodeFields,
  type DecodedSnapshot,
  type DecodedSnapshotNode,
  type NodeFields,
  type NodeMessages,
} from './snapshot-v2';

interface NestedEnvelopeV2 {
  readonly envelope: SnapshotEnvelope;
  readonly table: readonly unknown[];
  readonly root: unknown;
}

function readNestedEnvelopeV2(value: unknown): NestedEnvelopeV2 {
  const envelope = readSnapshotEnvelope(value);
  const table = envelope.record['messages'];
  const root = envelope.record['root'];
  if (envelope.snapshotFormatVersion !== 2) throw snapshotError('unsupported snapshot format');
  if (!Array.isArray(table)) throw snapshotError('invalid message table');
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw snapshotError('invalid node');
  }
  assertSnapshotDigest(envelope);
  return { envelope, table, root };
}

interface MutableNode extends DecodedSnapshotNode {
  readonly children: DecodedSnapshotNode[];
}

interface PendingNode {
  readonly value: unknown;
  readonly parent: (NodeFields & NodeMessages) | null;
  readonly parentNode: MutableNode | null;
}

export function decodeNestedSnapshotV2(value: unknown): DecodedSnapshot {
  const { envelope, table, root: rootValue } = readNestedEnvelopeV2(value);
  const seenIds = new Set<string>();
  const referencedIndexes = new Set<number>();
  const canonicalMessages = new Map<number, Message>();
  const pending: PendingNode[] = [{ value: rootValue, parent: null, parentNode: null }];
  let root: MutableNode | undefined;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const fields = readNodeFields(
      current.value,
      envelope,
      table.length,
      current.parent === null
        ? null
        : { id: current.parent.id, ids: current.parent.ids, sources: current.parent.sources },
      'nested',
    );
    if (seenIds.has(fields.id)) throw snapshotError(`duplicate node id ${fields.id}`);
    seenIds.add(fields.id);
    for (const index of fields.messageReferences.values()) referencedIndexes.add(index);
    const deserialized = deserializeNodeConversation(
      fields,
      table,
      envelope.conversationSchemaVersion,
    );
    const messages: Record<string, Message> = {};
    for (const messageId of fields.ids) {
      const index = fields.sources.get(messageId)!;
      let message = canonicalMessages.get(index);
      if (message === undefined) {
        message = deserialized.messages[messageId]!;
        canonicalMessages.set(index, message);
      }
      messages[messageId] = message;
    }
    const node: MutableNode = {
      id: fields.id,
      revision: fields.revision,
      conversation: deepFreeze({ ...deserialized, messages }),
      children: [],
    };
    if (current.parentNode === null) root = node;
    else current.parentNode.children.push(node);
    for (let index = fields.children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: fields.children[index]!, parent: fields, parentNode: node });
    }
  }

  if (root === undefined) throw snapshotError('invalid node');
  if (referencedIndexes.size !== table.length) {
    throw snapshotError('unreferenced message table entry');
  }
  assertLineageMatchesTree(envelope.lineage, root.id, seenIds);
  let current: DecodedSnapshotNode = root;
  for (const index of envelope.currentPath) {
    const child = current.children[index];
    if (!child) throw snapshotError(`current path index ${index} is out of range`);
    current = child;
  }
  if (
    current.id !== envelope.currentBranchId ||
    current.conversation.id !== envelope.conversationId
  ) {
    throw snapshotError('current identity mismatch');
  }
  return {
    conversationSchemaVersion: envelope.conversationSchemaVersion,
    controllerRevision: envelope.controllerRevision,
    conversationId: envelope.conversationId,
    currentBranchId: envelope.currentBranchId,
    createdAt: envelope.createdAt,
    currentPath: envelope.currentPath,
    lineage: envelope.lineage,
    root,
  };
}

export function currentConversationFromNestedSnapshotV2(value: unknown): ConversationHistory {
  const { envelope, table, root } = readNestedEnvelopeV2(value);
  let fields = readNodeFields(root, envelope, table.length, null, 'nested');
  for (const index of envelope.currentPath) {
    const child = fields.children[index];
    if (child === undefined) throw snapshotError(`current path index ${index} is out of range`);
    fields = readNodeFields(
      child,
      envelope,
      table.length,
      { id: fields.id, ids: fields.ids, sources: fields.sources },
      'nested',
    );
  }
  const conversation = deserializeNodeConversation(
    fields,
    table,
    envelope.conversationSchemaVersion,
  );
  if (fields.id !== envelope.currentBranchId || conversation.id !== envelope.conversationId) {
    throw snapshotError('current identity mismatch');
  }
  return deepFreeze(conversation);
}
