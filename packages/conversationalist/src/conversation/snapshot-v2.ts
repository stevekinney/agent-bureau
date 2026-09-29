/**
 * Snapshot format version 2: every distinct message is stored once in the
 * envelope's `messages` table, and each history node stores its conversation
 * as a delta from its parent (see `ConversationNodeSnapshot`).
 *
 * Version 1 stored every node's complete conversation. History keeps a node
 * per commit, so a snapshot grew with the square of the conversation's length,
 * and the operative store snapshots on every step. Here a node costs its
 * appended ids and changed messages, so an append-only history snapshots in
 * space linear in its messages.
 */
import type {
  ConversationHistory,
  ConversationHistoryHeader,
  ConversationNodeSnapshot,
  ConversationSnapshot,
  ConversationSnapshotLineage,
  Message,
} from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import { deserializeConversationHistory } from './serialization';
import {
  asRecord,
  assertLineageMatchesTree,
  assertSnapshotDigest,
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  finalizeSnapshot,
  isRecord,
  readRevision,
  readSnapshotEnvelope,
  readString,
  type SnapshotEnvelope,
  snapshotError,
  unsupportedSnapshotFormatVersion,
} from './snapshot-integrity';

/** A history node as restore consumes it: validated, frozen, and sharing message instances with its relatives. */
export interface DecodedSnapshotNode {
  readonly id: string;
  readonly revision: number;
  readonly conversation: ConversationHistory;
  readonly children: readonly DecodedSnapshotNode[];
}

/** A validated snapshot of any supported format version, decoded to full per-node conversations. */
export interface DecodedSnapshot {
  readonly conversationSchemaVersion: number;
  readonly controllerRevision: number;
  readonly conversationId: string;
  readonly currentBranchId: string;
  readonly createdAt: string;
  readonly currentPath: readonly number[];
  readonly lineage: ConversationSnapshotLineage;
  readonly root: DecodedSnapshotNode;
}

/** Any tree whose nodes carry a committed conversation: live history nodes or a decoded snapshot. */
export interface EncodableSnapshotNode {
  readonly id: string;
  readonly revision: number;
  readonly conversation: ConversationHistory;
  readonly children: readonly EncodableSnapshotNode[];
}

export type EncodableSnapshot = Omit<DecodedSnapshot, 'root'> & {
  readonly root: EncodableSnapshotNode;
};

interface NodeDelta {
  readonly parent: ConversationHistory | null;
  readonly retainedMessageCount: number;
  readonly appendedMessageIds: readonly string[];
  readonly changedMessages: readonly Message[];
}

/**
 * Committed conversations are immutable and outlive many snapshots, so each
 * node's delta is computed once. Recomputing it would compare the node's ids
 * with its parent's on every snapshot, which is linear per node and makes
 * each snapshot quadratic again.
 */
const nodeDeltas = new WeakMap<ConversationHistory, NodeDelta>();

function nodeDelta(
  parent: ConversationHistory | null,
  conversation: ConversationHistory,
): NodeDelta {
  const cached = nodeDeltas.get(conversation);
  if (cached !== undefined && cached.parent === parent) return cached;
  const parentIds = parent?.ids ?? [];
  let retainedMessageCount = 0;
  while (
    retainedMessageCount < parentIds.length &&
    retainedMessageCount < conversation.ids.length &&
    parentIds[retainedMessageCount] === conversation.ids[retainedMessageCount]
  ) {
    retainedMessageCount += 1;
  }
  // Identity, not id: a streamed, redacted, or repositioned message keeps its
  // id but is a different frozen object, and must be stored again.
  const changedMessages: Message[] = [];
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message !== undefined && message !== parent?.messages[id]) changedMessages.push(message);
  }
  const delta: NodeDelta = {
    parent,
    retainedMessageCount,
    appendedMessageIds: conversation.ids.slice(retainedMessageCount),
    changedMessages,
  };
  nodeDeltas.set(conversation, delta);
  return delta;
}

function historyHeader(conversation: ConversationHistory): ConversationHistoryHeader {
  const { ids: _ids, messages: _messages, ...header } = conversation;
  return header;
}

export function encodeSnapshot(state: EncodableSnapshot): ConversationSnapshot {
  const messages: Message[] = [];
  const messageIndexes = new Map<Message, number>();
  const referenceMessage = (message: Message): number => {
    let index = messageIndexes.get(message);
    if (index === undefined) {
      index = messages.length;
      messages.push(message);
      messageIndexes.set(message, index);
    }
    return index;
  };
  const encodeNode = (
    node: EncodableSnapshotNode,
    parent: EncodableSnapshotNode | null,
  ): ConversationNodeSnapshot => {
    const delta = nodeDelta(parent?.conversation ?? null, node.conversation);
    return {
      id: node.id,
      revision: node.revision,
      parentId: parent?.id ?? null,
      conversation: historyHeader(node.conversation),
      retainedMessageCount: delta.retainedMessageCount,
      appendedMessageIds: delta.appendedMessageIds,
      messageReferences: Object.fromEntries(
        delta.changedMessages.map((message) => [message.id, referenceMessage(message)]),
      ),
      children: node.children.map((child) => encodeNode(child, node)),
    };
  };
  const root = encodeNode(state.root, null);
  return finalizeSnapshot({
    snapshotFormatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
    conversationSchemaVersion: state.conversationSchemaVersion,
    controllerRevision: state.controllerRevision,
    conversationId: state.conversationId,
    currentBranchId: state.currentBranchId,
    messages,
    root,
    currentPath: state.currentPath,
    createdAt: state.createdAt,
    lineage: state.lineage,
  });
}

interface NodeFields {
  readonly id: string;
  readonly revision: number;
  readonly header: Record<string, unknown>;
  readonly messageReferences: ReadonlyMap<string, number>;
  readonly children: readonly unknown[];
}

/** The message ids a node resolves to, each mapped to its index in the envelope's table. */
interface NodeMessages {
  readonly ids: readonly string[];
  readonly sources: ReadonlyMap<string, number>;
}

interface ParentContext extends NodeMessages {
  readonly id: string;
}

function readNodeFields(
  value: unknown,
  envelope: SnapshotEnvelope,
  tableLength: number,
  parent: ParentContext | null,
): NodeFields & NodeMessages {
  const node = asRecord(value, 'node');
  const id = readString(node, 'id', 'node');
  const revision = readRevision(node, 'revision', 'node');
  if (revision > envelope.controllerRevision) throw snapshotError(`invalid node revision ${id}`);
  const parentId = node['parentId'];
  if (parentId !== null && typeof parentId !== 'string') throw snapshotError('invalid node');
  if (parentId !== (parent?.id ?? null)) throw snapshotError(`inconsistent parent for ${id}`);
  const header = asRecord(node['conversation'], 'node');
  const children = node['children'];
  if (!Array.isArray(children)) throw snapshotError('invalid node');

  const parentIds = parent?.ids ?? [];
  const retainedMessageCount = node['retainedMessageCount'];
  if (
    typeof retainedMessageCount !== 'number' ||
    !Number.isSafeInteger(retainedMessageCount) ||
    retainedMessageCount < 0 ||
    retainedMessageCount > parentIds.length
  ) {
    throw snapshotError(`invalid message delta for ${id}`);
  }
  const appendedMessageIds = node['appendedMessageIds'];
  if (
    !Array.isArray(appendedMessageIds) ||
    appendedMessageIds.some((messageId) => typeof messageId !== 'string')
  ) {
    throw snapshotError(`invalid message delta for ${id}`);
  }
  const rawReferences = node['messageReferences'];
  if (!isRecord(rawReferences)) throw snapshotError(`invalid message delta for ${id}`);
  const messageReferences = new Map<string, number>();
  for (const [messageId, index] of Object.entries(rawReferences)) {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= tableLength
    ) {
      throw snapshotError(`invalid message reference ${messageId} for ${id}`);
    }
    messageReferences.set(messageId, index);
  }

  const ids: string[] = [...parentIds.slice(0, retainedMessageCount), ...appendedMessageIds];
  const sources = new Map<string, number>();
  for (const messageId of ids) {
    const source = messageReferences.get(messageId) ?? parent?.sources.get(messageId);
    if (source === undefined) throw snapshotError(`missing message ${messageId} for ${id}`);
    sources.set(messageId, source);
  }
  for (const messageId of messageReferences.keys()) {
    if (!sources.has(messageId)) {
      throw snapshotError(`message reference ${messageId} is not listed for ${id}`);
    }
  }
  return { id, revision, header, messageReferences, children, ids, sources };
}

function deserializeNodeConversation(
  fields: NodeFields & NodeMessages,
  table: readonly unknown[],
  schemaVersion: number,
): ConversationHistory {
  const raw = {
    ...fields.header,
    ids: fields.ids,
    messages: Object.fromEntries(
      fields.ids.map((messageId) => [messageId, table[fields.sources.get(messageId)!]]),
    ),
  };
  let conversation: ConversationHistory;
  try {
    conversation = deserializeConversationHistory(raw);
  } catch (error) {
    throw snapshotError(
      `invalid conversation for ${fields.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (conversation.schemaVersion !== schemaVersion) {
    throw snapshotError('node conversation schema version mismatch');
  }
  return conversation;
}

function readEnvelopeV2(value: unknown): { envelope: SnapshotEnvelope; table: readonly unknown[] } {
  const envelope = readSnapshotEnvelope(value);
  if (envelope.snapshotFormatVersion !== 2) {
    throw unsupportedSnapshotFormatVersion(envelope.snapshotFormatVersion);
  }
  const table = envelope.record['messages'];
  if (!Array.isArray(table)) throw snapshotError('invalid message table');
  assertSnapshotDigest(envelope);
  return { envelope, table };
}

export function decodeSnapshotV2(value: unknown): DecodedSnapshot {
  const { envelope, table } = readEnvelopeV2(value);
  const seenIds = new Set<string>();
  const referencedIndexes = new Set<number>();
  // One instance per table entry, so restored nodes share messages exactly as
  // committed history does and the next snapshot stays compact.
  const canonicalMessages = new Map<number, Message>();

  const decodeNode = (nodeValue: unknown, parent: ParentContext | null): DecodedSnapshotNode => {
    const fields = readNodeFields(nodeValue, envelope, table.length, parent);
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
    const context: ParentContext = { id: fields.id, ids: fields.ids, sources: fields.sources };
    return {
      id: fields.id,
      revision: fields.revision,
      conversation: deepFreeze({ ...deserialized, messages }),
      children: fields.children.map((child) => decodeNode(child, context)),
    };
  };

  const root = decodeNode(envelope.record['root'], null);
  if (referencedIndexes.size !== table.length)
    throw snapshotError('unreferenced message table entry');
  assertLineageMatchesTree(envelope.lineage, root.id, seenIds);
  let current = root;
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

/**
 * The current branch's conversation from a version 2 snapshot, validated.
 *
 * Verifies the digest and reads only the nodes on `currentPath`, deserializing
 * just the final one, so it costs one conversation rather than a full restore.
 */
export function currentConversationFromSnapshotV2(value: unknown): ConversationHistory {
  const { envelope, table } = readEnvelopeV2(value);
  let fields = readNodeFields(envelope.record['root'], envelope, table.length, null);
  for (const index of envelope.currentPath) {
    const child = fields.children[index];
    if (child === undefined) throw snapshotError(`current path index ${index} is out of range`);
    fields = readNodeFields(child, envelope, table.length, {
      id: fields.id,
      ids: fields.ids,
      sources: fields.sources,
    });
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
