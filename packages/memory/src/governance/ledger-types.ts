import type { MemoryClass } from './policy';
import type {
  DerivedRecordKind,
  MemoryAttribution,
  MemoryRecordSourceReference,
} from './record-governance';

/**
 * The deletion-propagation targets of COR-806, in plan order. The managed asset
 * appears twice because its canonical record and its raw bytes sit in different
 * lanes.
 */
export const MEMORY_DELETION_TARGETS = [
  'source-evidence',
  'canonical-projections',
  'identity-views',
  'managed-asset-record',
  'indexes',
  'caches',
  'summaries',
  'managed-asset-bytes',
  'durable-snapshots',
  'exports',
  'external-processors',
] as const;
export type MemoryDeletionTarget = (typeof MEMORY_DELETION_TARGETS)[number];

/** Targets deleted together in one storage transaction at request time. */
export const SYNCHRONOUS_DELETION_TARGETS = [
  'source-evidence',
  'canonical-projections',
  'identity-views',
  'managed-asset-record',
] as const satisfies readonly MemoryDeletionTarget[];
export type SynchronousDeletionTarget = (typeof SYNCHRONOUS_DELETION_TARGETS)[number];

/** Targets deleted in the bounded-async lane, each against a deadline. */
export const ASYNCHRONOUS_DELETION_TARGETS = [
  'indexes',
  'caches',
  'summaries',
  'managed-asset-bytes',
  'durable-snapshots',
  'exports',
  'external-processors',
] as const satisfies readonly MemoryDeletionTarget[];
export type AsynchronousDeletionTarget = (typeof ASYNCHRONOUS_DELETION_TARGETS)[number];

/**
 * COR-806's five receipt statuses. `completed` means removed or invalidated;
 * `exempt` means retained (legal hold); `pending` carries a deadline and turns
 * `failed` if still pending when it passes; `unknown` is reserved for a target
 * whose deletion genuinely cannot be observed, never for unfinished work.
 */
export type MemoryDeletionTargetStatus = 'completed' | 'pending' | 'exempt' | 'failed' | 'unknown';

export interface MemoryDeletionTargetReceipt {
  readonly target: MemoryDeletionTarget;
  readonly lane: 'synchronous' | 'bounded-async';
  readonly status: MemoryDeletionTargetStatus;
  /** Present while a target is or was pending: trigger time plus its lane's bound. */
  readonly deadline?: number;
  readonly settledAt?: number;
  /** A safe explanation; never record content. */
  readonly detail?: string;
}

export interface MemoryDeletionPlan {
  readonly projections: readonly MemoryRecordSourceReference[];
  readonly identityViews: readonly MemoryRecordSourceReference[];
  readonly managedAssetRecords: readonly MemoryRecordSourceReference[];
  readonly summaries: readonly MemoryRecordSourceReference[];
}

/**
 * A durable deletion receipt. It is written before anything is deleted and
 * updated as each target settles, so a process restart resumes propagation
 * from it rather than from memory.
 */
export interface MemoryDeletionReceipt {
  readonly version: 1;
  readonly deletionId: string;
  readonly tenantId: string;
  /** `source` deletes source evidence and everything derived from it; `projection` one derived record. */
  readonly scope: 'source' | 'projection';
  readonly trigger: 'request' | 'retention-expiry' | 'hold-release';
  readonly record: {
    readonly id: string;
    readonly namespace: string;
    readonly ownerId: string;
    readonly collection: string;
    readonly memoryClass: MemoryClass;
    readonly contentDigest: string;
  };
  readonly plan: MemoryDeletionPlan;
  /**
   * SHA-256 digests of the content of every record this deletion removes, taken
   * before anything is deleted, so a content-addressed cache can still evict
   * them once the records are gone. Digests only, never content.
   */
  readonly contentDigests: readonly string[];
  readonly requestedBy: MemoryAttribution;
  readonly requestedAt: number;
  readonly boundMilliseconds: number;
  /** True when a legal hold stopped the deletion, exempting every target not yet settled; it re-queues on release. */
  readonly awaitingHoldRelease: boolean;
  readonly targets: readonly MemoryDeletionTargetReceipt[];
  /** True while any target is still pending. */
  readonly open: boolean;
  readonly updatedAt: number;
}

export interface MemoryExportManifest {
  readonly version: 1;
  readonly exportId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly exportedBy: MemoryAttribution;
  readonly recordIds: readonly string[];
  /** Records scrubbed from this manifest because a deletion removed or claimed them. */
  readonly removedRecordIds: readonly string[];
  readonly createdAt: number;
  readonly revoked: boolean;
  readonly revokedAt?: number;
  readonly revokedBy?: MemoryAttribution;
}

export interface MemoryLineageLink {
  readonly tenantId: string;
  readonly source: MemoryRecordSourceReference;
  readonly derived: MemoryRecordSourceReference & { readonly kind: DerivedRecordKind };
}

/**
 * A derived record whose derivation has not yet confirmed its sources. It is
 * written before the record is stored and removed once the record is
 * activated or withdrawn, so a derivation that fails or dies in between
 * leaves an entry for `processDeletionPropagation` to resolve.
 */
export interface MemoryPendingDerivation {
  readonly tenantId: string;
  readonly record: MemoryRecordSourceReference;
  readonly startedAt: number;
}

/**
 * Everything the governance ledger records about one operation. `reason` and
 * `diagnostic` are protected: only a privileged (`memory:inspect`) read returns
 * them. No event ever carries record content, only ids and digests.
 */
export interface MemoryGovernanceEvent {
  readonly id: string;
  readonly at: number;
  readonly tenantId: string;
  readonly type: string;
  readonly outcome: string;
  readonly attribution?: MemoryAttribution;
  readonly recordIds: readonly string[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly reason?: string;
  readonly diagnostic?: MemoryProtectedDiagnostic;
}

export interface MemoryProtectedDiagnostic {
  readonly detector: string;
  readonly category: string;
  readonly confidence: number;
  readonly contentDigest: string;
}
