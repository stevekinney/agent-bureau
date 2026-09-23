import { createSerializationError } from '../errors';
import { conversationSchema } from '../schemas';
import {
  type ConversationNodeSnapshot,
  type ConversationSnapshot,
  CURRENT_SCHEMA_VERSION,
} from '../types';
import { deepFreeze } from '../utilities/type-helpers';

export const CURRENT_SNAPSHOT_FORMAT_VERSION = 1 as const;

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}

export function snapshotDigest(snapshot: Omit<ConversationSnapshot, 'integrity'>): string {
  const serialized = stableStringify(snapshot);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function finalizeSnapshot(
  snapshot: Omit<ConversationSnapshot, 'integrity'>,
): ConversationSnapshot {
  return deepFreeze({
    ...snapshot,
    integrity: { algorithm: 'fnv1a-64' as const, digest: snapshotDigest(snapshot) },
  });
}

export function validateSnapshot(value: unknown): ConversationSnapshot {
  const envelope = asRecord(value, 'envelope');
  const snapshotFormatVersion = readNumber(envelope, 'snapshotFormatVersion', 'envelope');
  if (snapshotFormatVersion !== CURRENT_SNAPSHOT_FORMAT_VERSION) {
    throw createSerializationError(
      `failed to restore snapshot: unsupported snapshot format version ${String(snapshotFormatVersion)}`,
    );
  }
  const conversationSchemaVersion = readNumber(envelope, 'conversationSchemaVersion', 'envelope');
  if (conversationSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw createSerializationError(
      `failed to restore snapshot: unsupported conversation schema version ${String(conversationSchemaVersion)}`,
    );
  }
  const controllerRevision = readRevision(envelope, 'controllerRevision', 'controller');
  const conversationId = readString(envelope, 'conversationId', 'envelope');
  const currentBranchId = readString(envelope, 'currentBranchId', 'envelope');
  const createdAt = readString(envelope, 'createdAt', 'envelope');
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw createSerializationError('failed to restore snapshot: invalid envelope identity');
  }
  const currentPath = readPath(envelope);
  const lineage = readLineage(envelope);
  const integrity = readIntegrity(envelope);
  const seenIds = new Set<string>();
  const root = readNode(
    envelope['root'],
    conversationSchemaVersion,
    controllerRevision,
    null,
    seenIds,
  );
  if (lineage.retainedFloorNodeId !== root.id) {
    throw createSerializationError('failed to restore snapshot: retained floor identity mismatch');
  }
  for (const removedNodeId of lineage.removedNodeIds) {
    if (seenIds.has(removedNodeId)) {
      throw createSerializationError(
        `failed to restore snapshot: removed node ${removedNodeId} is still retained`,
      );
    }
  }
  const currentNode = resolvePath(root, currentPath);
  if (currentNode.id !== currentBranchId || currentNode.conversation.id !== conversationId) {
    throw createSerializationError('failed to restore snapshot: current identity mismatch');
  }
  const snapshot: ConversationSnapshot = {
    snapshotFormatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
    conversationSchemaVersion,
    controllerRevision,
    conversationId,
    currentBranchId,
    root,
    currentPath,
    createdAt,
    lineage,
    integrity,
  };
  const { integrity: unsignedIntegrity, ...unsigned } = snapshot;
  if (unsignedIntegrity.digest !== snapshotDigest(unsigned)) {
    throw createSerializationError('failed to restore snapshot: integrity digest mismatch');
  }
  return snapshot;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

function readRevision(record: Record<string, unknown>, key: string, label: string): number {
  const revision = readNumber(record, key, label);
  if (revision < 0) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label} revision`);
  }
  return revision;
}

function readPath(record: Record<string, unknown>): readonly number[] {
  const value = record['currentPath'];
  if (!Array.isArray(value) || value.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw createSerializationError('failed to restore snapshot: invalid current path');
  }
  return value;
}

function readLineage(record: Record<string, unknown>): ConversationSnapshot['lineage'] {
  const lineage = asRecord(record['lineage'], 'lineage evidence');
  const retainedFloorNodeId = readString(lineage, 'retainedFloorNodeId', 'lineage evidence');
  const removedNodeIds = lineage['removedNodeIds'];
  if (!Array.isArray(removedNodeIds) || removedNodeIds.some((id) => typeof id !== 'string')) {
    throw createSerializationError('failed to restore snapshot: invalid lineage evidence');
  }
  const parentConversationId = optionalString(lineage, 'parentConversationId');
  const forkPointMessageId = optionalString(lineage, 'forkPointMessageId');
  const sourceRevision = optionalRevision(lineage, 'sourceRevision');
  if ((parentConversationId === undefined) !== (sourceRevision === undefined)) {
    throw createSerializationError('failed to restore snapshot: invalid fork lineage');
  }
  return {
    retainedFloorNodeId,
    removedNodeIds,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(forkPointMessageId !== undefined ? { forkPointMessageId } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw createSerializationError('failed to restore snapshot: invalid fork lineage');
  }
  return value;
}

function optionalRevision(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw createSerializationError('failed to restore snapshot: invalid fork lineage');
  }
  return value;
}

function readIntegrity(record: Record<string, unknown>): ConversationSnapshot['integrity'] {
  const integrity = asRecord(record['integrity'], 'integrity evidence');
  if (integrity['algorithm'] !== 'fnv1a-64') {
    throw createSerializationError('failed to restore snapshot: invalid integrity evidence');
  }
  const digest = integrity['digest'];
  if (typeof digest !== 'string' || !/^[0-9a-f]{16}$/.test(digest)) {
    throw createSerializationError('failed to restore snapshot: invalid integrity digest');
  }
  return { algorithm: 'fnv1a-64', digest };
}

function readNode(
  value: unknown,
  schemaVersion: number,
  controllerRevision: number,
  expectedParentId: string | null,
  seenIds: Set<string>,
): ConversationNodeSnapshot {
  const node = asRecord(value, 'node');
  const id = readString(node, 'id', 'node');
  const revision = readRevision(node, 'revision', 'node');
  if (seenIds.has(id)) {
    throw createSerializationError(`failed to restore snapshot: duplicate node id ${id}`);
  }
  if (revision > controllerRevision) {
    throw createSerializationError(`failed to restore snapshot: invalid node revision ${id}`);
  }
  const parentId = node['parentId'];
  if (parentId !== null && typeof parentId !== 'string') {
    throw createSerializationError('failed to restore snapshot: invalid node');
  }
  if (parentId !== expectedParentId) {
    throw createSerializationError(`failed to restore snapshot: inconsistent parent for ${id}`);
  }
  const parsedConversation = conversationSchema.safeParse(node['conversation']);
  if (!parsedConversation.success || parsedConversation.data.schemaVersion !== schemaVersion) {
    throw createSerializationError(
      'failed to restore snapshot: node conversation schema version mismatch',
    );
  }
  const children = node['children'];
  if (!Array.isArray(children)) {
    throw createSerializationError('failed to restore snapshot: invalid node');
  }
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
  root: ConversationNodeSnapshot,
  path: readonly number[],
): ConversationNodeSnapshot {
  let current = root;
  for (const index of path) {
    const child = current.children[index];
    if (!child) {
      throw createSerializationError(
        `failed to restore snapshot: current path index ${index} is out of range`,
      );
    }
    current = child;
  }
  return current;
}
