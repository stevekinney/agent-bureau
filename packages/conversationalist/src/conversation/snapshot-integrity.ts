import { createSerializationError } from '../errors';
import { type ConversationSnapshot, CURRENT_SCHEMA_VERSION, type JSONValue } from '../types';
import { deepFreeze } from '../utilities/type-helpers';

export const CURRENT_SNAPSHOT_FORMAT_VERSION = 1 as const;

function stableStringify(value: JSONValue): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}

export function snapshotDigest(snapshot: Omit<ConversationSnapshot, 'integrity'>): string {
  const serialized = stableStringify(snapshot as unknown as JSONValue);
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
  if (!value || typeof value !== 'object') {
    throw createSerializationError('failed to restore snapshot: invalid envelope');
  }
  const snapshot = value as ConversationSnapshot;
  const validateNodeShape = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      throw createSerializationError('failed to restore snapshot: invalid node');
    }
    const candidate = node as Record<string, unknown>;
    if (
      typeof candidate['id'] !== 'string' ||
      !Number.isSafeInteger(candidate['revision']) ||
      (candidate['parentId'] !== null && typeof candidate['parentId'] !== 'string') ||
      !candidate['conversation'] ||
      typeof candidate['conversation'] !== 'object' ||
      !Array.isArray(candidate['children'])
    ) {
      throw createSerializationError('failed to restore snapshot: invalid node');
    }
    for (const child of candidate['children']) validateNodeShape(child);
  };
  if (snapshot.snapshotFormatVersion !== CURRENT_SNAPSHOT_FORMAT_VERSION) {
    throw createSerializationError(
      `failed to restore snapshot: unsupported snapshot format version ${String(snapshot.snapshotFormatVersion)}`,
    );
  }
  if (snapshot.conversationSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw createSerializationError(
      `failed to restore snapshot: unsupported conversation schema version ${String(snapshot.conversationSchemaVersion)}`,
    );
  }
  if (!Number.isSafeInteger(snapshot.controllerRevision) || snapshot.controllerRevision < 0) {
    throw createSerializationError('failed to restore snapshot: invalid controller revision');
  }
  if (
    !Array.isArray(snapshot.currentPath) ||
    snapshot.currentPath.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    throw createSerializationError('failed to restore snapshot: invalid current path');
  }
  if (
    !snapshot.lineage ||
    typeof snapshot.lineage.retainedFloorNodeId !== 'string' ||
    !Array.isArray(snapshot.lineage.removedNodeIds) ||
    snapshot.lineage.removedNodeIds.some((id) => typeof id !== 'string')
  ) {
    throw createSerializationError('failed to restore snapshot: invalid lineage evidence');
  }
  if (!snapshot.integrity || snapshot.integrity.algorithm !== 'fnv1a-64') {
    throw createSerializationError('failed to restore snapshot: invalid integrity evidence');
  }
  validateNodeShape(snapshot.root);
  const { integrity, ...unsigned } = snapshot;
  if (integrity.digest !== snapshotDigest(unsigned)) {
    throw createSerializationError('failed to restore snapshot: integrity digest mismatch');
  }
  return snapshot;
}
