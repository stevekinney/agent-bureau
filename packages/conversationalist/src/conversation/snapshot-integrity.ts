/**
 * Integrity and envelope primitives shared by every snapshot format version.
 *
 * Format-specific tree encoding and decoding live in `snapshot-v1.ts` and
 * `snapshot-v2.ts`; `snapshot-format.ts` dispatches between them.
 */
import { createSerializationError } from '../errors';
import {
  type ConversationSnapshotIntegrity,
  type ConversationSnapshotLineage,
  CURRENT_SCHEMA_VERSION,
} from '../types';
import { deepFreeze } from '../utilities/type-helpers';

export const CURRENT_SNAPSHOT_FORMAT_VERSION = 2 as const;

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}

/**
 * 64-bit FNV-1a over UTF-16 code units, as 16 lowercase hex digits.
 *
 * The state is four 16-bit limbs (`h0` least significant) rather than a
 * `BigInt`: every step completion snapshots the whole conversation, so this
 * loop runs over the full serialized snapshot once per step, and per-character
 * `BigInt` multiplication made long runs quadratic with a large constant. The
 * FNV prime is `2^40 + 0x1b3`, so multiplying by it is `h * 0x1b3` plus `h`
 * shifted up two limbs and 8 bits (`* 0x100` into limb 2). Every intermediate
 * stays below 2^31, so `>>> 16` carries are exact. Output is bit-identical to
 * the `BigInt` form, which keeps persisted `fnv1a-64` digests valid.
 */
export function fnv1a64(text: string): string {
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let index = 0; index < text.length; index += 1) {
    h0 ^= text.charCodeAt(index);
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, '0')).join('');
}

/** The `fnv1a-64` digest of a snapshot without its `integrity` field. */
export function snapshotDigest(unsigned: object): string {
  return fnv1a64(stableStringify(unsigned));
}

export function finalizeSnapshot<T extends object>(
  unsigned: T,
): Readonly<T & { integrity: ConversationSnapshotIntegrity }> {
  return deepFreeze({
    ...unsigned,
    integrity: { algorithm: 'fnv1a-64' as const, digest: snapshotDigest(unsigned) },
  });
}

export function snapshotError(detail: string): Error {
  return createSerializationError(`failed to restore snapshot: ${detail}`);
}

/** Envelope fields every snapshot format version carries, validated. */
export interface SnapshotEnvelope {
  readonly record: Record<string, unknown>;
  readonly snapshotFormatVersion: number;
  readonly conversationSchemaVersion: number;
  readonly controllerRevision: number;
  readonly conversationId: string;
  readonly currentBranchId: string;
  readonly createdAt: string;
  readonly currentPath: readonly number[];
  readonly lineage: ConversationSnapshotLineage;
  /** Per-message stream sequence counters; absent from snapshots written before they were persisted. */
  readonly streamSequences: Readonly<Record<string, number>>;
  readonly integrity: ConversationSnapshotIntegrity;
}

export function readSnapshotFormatVersion(value: unknown): number {
  return readNumber(asRecord(value, 'envelope'), 'snapshotFormatVersion', 'envelope');
}

export function unsupportedSnapshotFormatVersion(version: number): Error {
  return snapshotError(`unsupported snapshot format version ${String(version)}`);
}

export function readSnapshotEnvelope(value: unknown): SnapshotEnvelope {
  const record = asRecord(value, 'envelope');
  const snapshotFormatVersion = readNumber(record, 'snapshotFormatVersion', 'envelope');
  const conversationSchemaVersion = readNumber(record, 'conversationSchemaVersion', 'envelope');
  if (conversationSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw snapshotError(
      `unsupported conversation schema version ${String(conversationSchemaVersion)}`,
    );
  }
  const controllerRevision = readRevision(record, 'controllerRevision', 'controller');
  const conversationId = readString(record, 'conversationId', 'envelope');
  const currentBranchId = readString(record, 'currentBranchId', 'envelope');
  const createdAt = readString(record, 'createdAt', 'envelope');
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw snapshotError('invalid envelope identity');
  }
  return {
    record,
    snapshotFormatVersion,
    conversationSchemaVersion,
    controllerRevision,
    conversationId,
    currentBranchId,
    createdAt,
    currentPath: readPath(record),
    lineage: readLineage(record),
    streamSequences: readStreamSequences(record),
    integrity: readIntegrity(record),
  };
}

function readStreamSequences(record: Record<string, unknown>): Readonly<Record<string, number>> {
  const value = record['streamSequences'];
  if (value === undefined) return {};
  if (!isRecord(value)) throw snapshotError('invalid stream sequences');
  const sequences: Record<string, number> = {};
  for (const [messageId, sequence] of Object.entries(value)) {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw snapshotError(`invalid stream sequences for ${messageId}`);
    }
    sequences[messageId] = sequence;
  }
  return sequences;
}

/** Verifies `integrity` against the envelope as received, minus the `integrity` field itself. */
export function assertSnapshotDigest(envelope: SnapshotEnvelope): void {
  const { integrity: _integrity, ...unsigned } = envelope.record;
  if (envelope.integrity.digest !== snapshotDigest(unsigned)) {
    throw snapshotError('integrity digest mismatch');
  }
}

/** Retained-floor and removed-node lineage checks every format applies once its tree is read. */
export function assertLineageMatchesTree(
  lineage: ConversationSnapshotLineage,
  rootId: string,
  retainedNodeIds: ReadonlySet<string>,
): void {
  if (lineage.retainedFloorNodeId !== rootId) {
    throw snapshotError('retained floor identity mismatch');
  }
  for (const removedNodeId of lineage.removedNodeIds) {
    if (retainedNodeIds.has(removedNodeId)) {
      throw snapshotError(`removed node ${removedNodeId} is still retained`);
    }
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

export function readNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label}`);
  }
  return value;
}

export function readRevision(record: Record<string, unknown>, key: string, label: string): number {
  const revision = readNumber(record, key, label);
  if (revision < 0) {
    throw createSerializationError(`failed to restore snapshot: invalid ${label} revision`);
  }
  return revision;
}

export function readPath(record: Record<string, unknown>): readonly number[] {
  const value = record['currentPath'];
  if (!Array.isArray(value) || value.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw createSerializationError('failed to restore snapshot: invalid current path');
  }
  return value;
}

function readLineage(record: Record<string, unknown>): ConversationSnapshotLineage {
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

function readIntegrity(record: Record<string, unknown>): ConversationSnapshotIntegrity {
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
