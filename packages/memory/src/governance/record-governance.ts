import { sha256HexSync } from '@lostgradient/cryptography';
import { z } from 'zod';

import type { MemoryRecord } from '../memory-record-storage';
import {
  MEMORY_CAPABILITIES,
  MEMORY_PRINCIPAL_KINDS,
  MEMORY_PROJECTIONS,
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryDelegationLink,
  type MemoryPrincipal,
  type MemoryProjection,
} from './authority';
import {
  MEMORY_CLASSES,
  MEMORY_SOURCE_KINDS,
  MEMORY_TRUST_LEVELS,
  type MemoryClass,
  type MemorySourceKind,
  type MemoryTrust,
} from './policy';
import type {
  MemoryRecordState,
  MemoryRedaction,
  MemoryResourceDescriptor,
  MemoryVisibility,
} from './predicate';

/** The reserved metadata key holding a governed record's envelope. Callers can never set it. */
export const MEMORY_GOVERNANCE_METADATA_KEY = 'memoryGovernance';

/**
 * Derived records a source deletion reaches. Canonical projections, identity
 * views, and the managed-asset canonical record delete synchronously with their
 * source; summaries delete in the bounded-async lane (COR-806).
 */
export const DERIVED_RECORD_KINDS = [
  'canonical-projection',
  'identity-view',
  'managed-asset-record',
  'summary',
] as const;
export type DerivedRecordKind = (typeof DERIVED_RECORD_KINDS)[number];

export type LegalHoldState = 'none' | 'held' | 'released';

/**
 * Who performed an operation, under which authority, and under which policy.
 * Persisted on every record, receipt, and event.
 */
export interface MemoryAttribution {
  readonly principal: MemoryPrincipal;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly capabilities: readonly MemoryCapability[];
  readonly delegationChain: readonly MemoryDelegationLink[];
  readonly policyRevision: string;
  readonly projection: MemoryProjection;
  readonly governanceRevision: string;
  readonly operationId: string;
  readonly at: number;
}

export interface MemoryRecordSourceReference {
  readonly id: string;
  readonly namespace: string;
}

export interface MemoryRecordLineage {
  readonly kind: DerivedRecordKind;
  readonly sources: readonly MemoryRecordSourceReference[];
}

/** The governance envelope persisted on every governed record. */
export interface RecordGovernance {
  readonly version: 1;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly collection: string;
  readonly visibility: MemoryVisibility;
  readonly memoryClass: MemoryClass;
  readonly source: MemorySourceKind;
  readonly trust: MemoryTrust;
  readonly state: MemoryRecordState;
  readonly legalHold: LegalHoldState;
  readonly sharedWith: readonly string[];
  readonly contentDigest: string;
  /** Event or observation time; the episodic retention clock starts here. */
  readonly eventAt: number;
  /** Multiplier applied to retrieval scores; lowered by retrieval demotion. */
  readonly retrievalWeight: number;
  /** When true the record is excluded from search until re-indexed; `get` still reads it. */
  readonly indexInvalidated: boolean;
  readonly invalidatedAt?: number;
  readonly supersededBy?: string;
  /**
   * When a deletion claimed this record, before it planned what the deletion
   * reaches. A claimed record can no longer back a promotion or a derived
   * write, so nothing derived from it can appear after the plan is final.
   */
  readonly deletionRequestedAt?: number;
  readonly runId?: string;
  readonly lineage?: MemoryRecordLineage;
  /**
   * Set on a derived record from the moment it is stored until its derivation
   * has checked its sources again and activated it. A pending record exists
   * for no governed operation: every read and transition treats it as
   * missing, so a derivation that fails or dies before activating leaves a
   * record nobody can see, which `processDeletionPropagation` then removes or
   * activates.
   */
  readonly pendingDerivation?: true;
  readonly attribution: MemoryAttribution;
}

export interface ReadRecordGovernance {
  readonly governance: RecordGovernance;
  readonly integrity: 'intact' | 'tampered';
}

const nonEmpty = z.string().min(1);
const principalSchema = z.object({ kind: z.enum(MEMORY_PRINCIPAL_KINDS), id: nonEmpty });
const capabilitySchema = z.enum(MEMORY_CAPABILITIES as [MemoryCapability, ...MemoryCapability[]]);
/** Validates a persisted {@link MemoryAttribution}. */
export const memoryAttributionSchema = z.object({
  principal: principalSchema,
  tenantId: nonEmpty,
  ownerId: nonEmpty,
  purpose: nonEmpty,
  capabilities: z.array(capabilitySchema),
  delegationChain: z
    .array(z.object({ principal: principalSchema, capabilities: z.array(capabilitySchema) }))
    .min(1),
  policyRevision: nonEmpty,
  projection: z.enum(MEMORY_PROJECTIONS),
  governanceRevision: nonEmpty,
  operationId: nonEmpty,
  at: z.number(),
});
/** Validates a persisted source reference. */
export const memorySourceReferenceSchema = z.object({ id: nonEmpty, namespace: nonEmpty });

const governanceSchema = z.object({
  version: z.literal(1),
  tenantId: nonEmpty,
  ownerId: nonEmpty,
  collection: nonEmpty,
  visibility: z.enum(['private', 'shared']),
  memoryClass: z.enum(MEMORY_CLASSES),
  source: z.enum(MEMORY_SOURCE_KINDS),
  trust: z.enum(MEMORY_TRUST_LEVELS),
  state: z.enum(['active', 'quarantined', 'revoked']),
  legalHold: z.enum(['none', 'held', 'released']),
  sharedWith: z.array(nonEmpty),
  contentDigest: nonEmpty,
  eventAt: z.number(),
  retrievalWeight: z.number().min(0).max(1),
  indexInvalidated: z.boolean(),
  invalidatedAt: z.number().optional(),
  supersededBy: nonEmpty.optional(),
  deletionRequestedAt: z.number().optional(),
  runId: nonEmpty.optional(),
  lineage: z
    .object({
      kind: z.enum(DERIVED_RECORD_KINDS),
      sources: z.array(memorySourceReferenceSchema).min(1),
    })
    .optional(),
  pendingDerivation: z.literal(true).optional(),
  attribution: memoryAttributionSchema,
});

/**
 * The storage namespace a collection lives in. Private collections are
 * partitioned by owner and shared ones sit in the tenant-wide shared partition;
 * both components are percent-encoded, so no collection string a caller or a
 * model supplies can name another owner's partition.
 */
export function collectionNamespace(
  visibility: MemoryVisibility,
  ownerId: string,
  collection: string,
): string {
  const encodedCollection = encodeURIComponent(collection);
  return visibility === 'shared'
    ? `shared:${encodedCollection}`
    : `private:${encodeURIComponent(ownerId)}:${encodedCollection}`;
}

export function attributionFor(
  authority: MemoryAuthority,
  context: { governanceRevision: string; operationId: string; at: number },
): MemoryAttribution {
  return {
    principal: authority.principal,
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    purpose: authority.purpose,
    capabilities: authority.capabilities,
    delegationChain: authority.delegationChain,
    policyRevision: authority.policyRevision,
    projection: authority.projection,
    ...context,
  };
}

export function digestContent(content: string): string {
  return sha256HexSync(content);
}

/**
 * Reads a record's governance envelope. A missing or malformed envelope, or one
 * whose tenant or owner partition disagrees with where the record is stored, is
 * ungoverned and returns `undefined`, so every caller fails closed on it. Content
 * that no longer matches its admission digest reads back as `tampered`.
 */
export function readRecordGovernance(record: MemoryRecord): ReadRecordGovernance | undefined {
  const parsed = governanceSchema.safeParse(record.metadata[MEMORY_GOVERNANCE_METADATA_KEY]);
  if (!parsed.success) return undefined;
  const governance = parsed.data as RecordGovernance;
  const expectedNamespace = collectionNamespace(
    governance.visibility,
    governance.ownerId,
    governance.collection,
  );
  if (record.tenantId !== governance.tenantId || record.namespace !== expectedNamespace) {
    return undefined;
  }
  const integrity =
    digestContent(record.content) === governance.contentDigest ? 'intact' : 'tampered';
  return { governance, integrity };
}

export function describeResource(read: ReadRecordGovernance): MemoryResourceDescriptor {
  const { governance } = read;
  return {
    tenantId: governance.tenantId,
    ownerId: governance.ownerId,
    visibility: governance.visibility,
    state: governance.state,
    sharedWith: governance.sharedWith,
    integrity: read.integrity,
    pendingDerivation: governance.pendingDerivation === true,
  };
}

/** Removes the reserved governance key from metadata a caller supplied. */
export function withoutReservedMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { [MEMORY_GOVERNANCE_METADATA_KEY]: _reserved, ...rest } = metadata;
  return rest;
}

/** A governed record as a caller sees it after the redaction decision. */
export interface GovernedMemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly collection: string;
  readonly visibility: MemoryVisibility;
  readonly memoryClass: MemoryClass;
  readonly source: MemorySourceKind;
  readonly trust: MemoryTrust;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  /** Present only under privileged redaction. */
  readonly governance?: RecordGovernance;
  /** Present only under privileged redaction. */
  readonly integrity?: 'intact' | 'tampered';
}

export function projectRecord(
  record: MemoryRecord,
  read: ReadRecordGovernance,
  redaction: MemoryRedaction,
): GovernedMemoryRecord {
  const { governance } = read;
  return {
    id: record.id,
    content: record.content,
    collection: governance.collection,
    visibility: governance.visibility,
    memoryClass: governance.memoryClass,
    source: governance.source,
    trust: governance.trust,
    metadata: withoutReservedMetadata(record.metadata),
    createdAt: record.createdAt,
    ...(redaction === 'privileged' ? { governance, integrity: read.integrity } : {}),
  };
}
