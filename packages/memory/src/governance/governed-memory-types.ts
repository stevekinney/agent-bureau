import type { Embedder } from '@lostgradient/embeddings';
import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { MemoryRecordStorage } from '../memory-record-storage';
import type { TextSearchProvider } from '../text-search-provider';
import type { MemoryAuthority } from './authority';
import type { MemoryEvidence } from './evidence';
import type { MemoryGovernanceLedger } from './ledger';
import type {
  AsynchronousDeletionTarget,
  MemoryDeletionPlan,
  MemoryDeletionReceipt,
  MemoryDeletionTargetStatus,
  MemoryGovernanceEvent,
} from './ledger-types';
import type { MemoryClass, MemoryGovernancePolicy, MemorySourceKind } from './policy';
import type { MemoryVisibility } from './predicate';
import type { DerivedRecordKind, GovernedMemoryRecord } from './record-governance';

/**
 * Where to look for one record. Every component is a selector inside the scope
 * the caller's authority already owns: the tenant always comes from the
 * authority, and access is decided by the record's persisted governance, never
 * by these strings.
 */
export interface MemoryRecordLocator {
  readonly id: string;
  readonly collection: string;
  /** Defaults to `private`. */
  readonly visibility?: MemoryVisibility;
  /** Another owner's partition, for a share grantee or a governance principal. Defaults to the caller's owner. */
  readonly ownerId?: string;
}

export interface GovernedWriteOptions {
  readonly collection: string;
  /** Where the content came from; ordinary conversation and model tools are untrusted. */
  readonly source: MemorySourceKind;
  /** Defaults to `episodic`. */
  readonly memoryClass?: MemoryClass;
  /** Extension metadata; the reserved governance key is always stripped. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Makes the write idempotent: a second write with the same key returns the first record. */
  readonly dedupeKey?: string;
  /** The owning run. Required for working memory, whose lifetime is the run's. */
  readonly runId?: string;
  /** Event or observation time. Defaults to the write time. */
  readonly eventAt?: number;
  /**
   * Registers this record as derived from existing records the caller may write:
   * an identity view, a managed asset's canonical record, a summary, or another
   * canonical projection. The record is never more trusted than its least trusted
   * source, and deleting or revoking a source reaches it.
   */
  readonly derivedFrom?: {
    readonly kind: DerivedRecordKind;
    readonly sources: readonly MemoryRecordLocator[];
  };
}

export type MemoryWriteRejection =
  | 'missing-capability'
  | 'invalid-content'
  | 'invalid-request'
  | 'source-not-permitted'
  | 'quota-exceeded'
  | 'invalid-source'
  | 'content-policy';

/**
 * The outcome of a governed write. It deliberately omits which detector fired
 * or why: protected diagnostics go to the governance ledger, never back to the
 * (possibly model-facing) writer.
 */
export interface MemoryWriteReceipt {
  readonly operationId: string;
  readonly status: 'admitted' | 'quarantined' | 'rejected' | 'duplicate';
  readonly recordId?: string;
  readonly reason?: MemoryWriteRejection;
}

export type MemoryOperationStatus = 'applied' | 'unchanged' | 'not-found' | 'denied' | 'rejected';

export interface MemoryOperationResult {
  readonly operationId: string;
  readonly status: MemoryOperationStatus;
  readonly reason?: string;
  readonly recordIds?: readonly string[];
}

export interface GovernedListOptions {
  readonly collection: string;
  /** Defaults to `all`: the caller's private collection plus the shared one. */
  readonly visibility?: MemoryVisibility | 'all';
  readonly limit?: number;
  readonly offset?: number;
}

export interface GovernedSearchOptions {
  readonly collection: string;
  readonly visibility?: MemoryVisibility | 'all';
  readonly limit?: number;
  readonly memoryClass?: MemoryClass;
}

export interface GovernedSearchHit {
  readonly record: GovernedMemoryRecord;
  readonly score: number;
}

export interface RecallForModelOptions extends GovernedSearchOptions {
  /** The run or session context records were evicted from; evicted records never come back into it. */
  readonly contextId?: string;
}

/** What a model is allowed to see from a recall: labeled evidence, and only a count of what was withheld. */
export interface MemoryEvidenceBundle {
  readonly operationId: string;
  readonly evidence: readonly MemoryEvidence[];
  readonly withheld: number;
  readonly rendered: string;
}

export interface MemoryExportResult extends MemoryOperationResult {
  readonly exportId?: string;
  readonly records: readonly GovernedMemoryRecord[];
}

/**
 * What a deletion did to the record it names: `status` is `applied` only when
 * the record is gone, and `unchanged` whenever a receipt shows it still stored.
 */
export interface MemoryDeletionResult extends MemoryOperationResult {
  readonly receipt?: MemoryDeletionReceipt;
  /**
   * The status of the receipt row that removes the named record (its
   * `source-evidence` row, or a projection's own target), in COR-806's
   * vocabulary. Present whenever `receipt` is.
   *
   * - `completed`: removed, so it is no longer readable or recallable, even
   *   while bounded-async rows are still `pending`. After a source deletion, a
   *   summary its lineage reaches stays stored until the receipt's `summaries`
   *   row completes, and until then no other bounded-async row claims
   *   completion. A projection deletion removes only its own record, so
   *   records derived from it stay stored.
   * - `exempt`: a legal hold holds the deletion, so the record stays stored
   *   and the deletion re-queues when the hold is released. A hold on the
   *   record holds it and, for a source deletion only, so does a hold on
   *   anything its lineage reaches.
   * - `failed`: the step that removes it failed, so the record stays stored.
   *   Requesting the deletion again retries the same receipt, and so does
   *   each propagation pass while the receipt is open when the failed step is
   *   the synchronous lane.
   *
   * A summary deleted as a projection is removed in the bounded-async lane,
   * so its row can also be `pending` or `unknown`.
   */
  readonly deletion?: MemoryDeletionTargetStatus;
}

/**
 * The ten distinct ways to forget. Each has its own semantics and capability:
 * only `source-deletion`, `projection-deletion`, and `retention-expiry` remove
 * anything, and each of those produces a deletion receipt.
 */
export type MemoryForgetRequest =
  | {
      readonly mode: 'active-context-eviction';
      readonly contextId: string;
      readonly locators: readonly MemoryRecordLocator[];
    }
  | {
      readonly mode: 'retrieval-demotion';
      readonly locator: MemoryRecordLocator;
      readonly weight: number;
    }
  | {
      readonly mode: 'consolidation';
      readonly locators: readonly MemoryRecordLocator[];
      readonly content: string;
      readonly collection: string;
    }
  | {
      readonly mode: 'supersession';
      readonly locator: MemoryRecordLocator;
      readonly successor: { readonly content: string } & GovernedWriteOptions;
    }
  | { readonly mode: 'quarantine'; readonly locator: MemoryRecordLocator; readonly reason: string }
  | { readonly mode: 'source-deletion'; readonly locator: MemoryRecordLocator }
  | { readonly mode: 'projection-deletion'; readonly locator: MemoryRecordLocator }
  | { readonly mode: 'index-invalidation'; readonly locator: MemoryRecordLocator }
  | { readonly mode: 'retention-expiry'; readonly locator: MemoryRecordLocator }
  | { readonly mode: 'export-revocation'; readonly exportId: string };

export type MemoryForgetMode = MemoryForgetRequest['mode'];

/** The deletion modes carry `receipt` and `deletion` exactly as {@link MemoryDeletionResult} does. */
export interface MemoryForgetResult extends MemoryDeletionResult {
  readonly mode: MemoryForgetMode;
  readonly write?: MemoryWriteReceipt;
}

export interface MemoryRetentionCandidate {
  readonly id: string;
  readonly namespace: string;
  readonly memoryClass: MemoryClass;
  readonly expiresAt: number;
  readonly held: boolean;
}

export interface MemoryRetentionSweep {
  readonly operationId: string;
  readonly status: MemoryOperationStatus;
  /** Why a sweep was rejected, for example a candidate policy outside a dry run. */
  readonly reason?: string;
  readonly dryRun: boolean;
  readonly policyRevision: string;
  readonly expired: readonly MemoryRetentionCandidate[];
  readonly deletionIds: readonly string[];
  readonly prunedEvents: number;
  readonly prunedReceipts: number;
}

export interface MemoryDeletionPropagationRequest {
  readonly deletionId: string;
  readonly tenantId: string;
  readonly target: AsynchronousDeletionTarget;
  readonly record: MemoryDeletionReceipt['record'];
  readonly plan: MemoryDeletionPlan;
  /** Content digests of every deleted record, for a content-addressed cache or store. */
  readonly contentDigests: readonly string[];
}

/**
 * Reports one bounded-async target's progress. `pending` keeps the target open
 * until its deadline; `unknown` is for a processor that genuinely offers no
 * deletion evidence.
 */
export interface MemoryDeletionPropagationResult {
  readonly status: 'completed' | 'pending' | 'failed' | 'unknown';
  readonly detail?: string;
}

export interface MemoryDeletionPropagator {
  propagate(request: MemoryDeletionPropagationRequest): Promise<MemoryDeletionPropagationResult>;
}

/**
 * How a deployment deletes each bounded-async target. `not-retained` is an
 * explicit declaration that the deployment keeps no copy in that target; a
 * target with neither a propagator, a built-in handler, nor that declaration
 * stays pending and fails at its deadline (governance fails closed).
 */
export type MemoryDeletionPropagation = Partial<
  Record<AsynchronousDeletionTarget, MemoryDeletionPropagator | 'not-retained'>
>;

/** The redacted form of a governance event handed to `onEvent` (for example, for a host's audit trail). */
export interface MemoryGovernanceNotification {
  readonly type: string;
  readonly outcome: string;
  readonly tenantId: string;
  readonly at: number;
  readonly recordIds: readonly string[];
  readonly operationId?: string;
  readonly principalId?: string;
  readonly projection?: string;
}

export interface CreateGovernedMemoryOptions {
  /** Record storage owned exclusively by this governed memory. Must implement `deleteMany`. */
  readonly storage: MemoryRecordStorage;
  readonly ledger: MemoryGovernanceLedger;
  readonly embedder: Embedder;
  readonly policy: MemoryGovernancePolicy;
  readonly textSearchProvider?: TextSearchProvider;
  readonly propagation?: MemoryDeletionPropagation;
  readonly runtime?: RuntimeServices;
  /**
   * Awaited inside each governed call, after its event is appended to the
   * ledger. A throw or rejection escapes the call with its change and its
   * ledger event already stored, so the sink should never throw.
   */
  readonly onEvent?: (notification: MemoryGovernanceNotification) => void | Promise<void>;
}

export interface MemoryLegalHoldResult extends MemoryOperationResult {
  /** Deletions re-queued by a release, per COR-806. */
  readonly requeued?: readonly string[];
}

/**
 * Principal-aware memory. Every method takes the caller's {@link MemoryAuthority}
 * and decides access with the one shared resource predicate; every mutation
 * persists its attribution and every governance transition is recorded in the
 * ledger.
 */
export interface GovernedMemory {
  /** The governance policy revision currently in force. */
  readonly policyRevision: string;
  init(): Promise<void>;
  close(): Promise<void>;
  write(
    authority: MemoryAuthority,
    content: string,
    options: GovernedWriteOptions,
  ): Promise<MemoryWriteReceipt>;
  get(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
  ): Promise<GovernedMemoryRecord | undefined>;
  list(authority: MemoryAuthority, options: GovernedListOptions): Promise<GovernedMemoryRecord[]>;
  search(
    authority: MemoryAuthority,
    query: string,
    options: GovernedSearchOptions,
  ): Promise<GovernedSearchHit[]>;
  /** The only recall path meant for model injection: mandatory trust and guardrail admission. */
  recallForModel(
    authority: MemoryAuthority,
    query: string,
    options: RecallForModelOptions,
  ): Promise<MemoryEvidenceBundle>;
  promote(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
    options?: { readonly collection?: string },
  ): Promise<MemoryOperationResult & { readonly sharedId?: string }>;
  share(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
    granteeOwnerId: string,
  ): Promise<MemoryOperationResult>;
  revokeShare(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
    granteeOwnerId: string,
  ): Promise<MemoryOperationResult>;
  export(authority: MemoryAuthority, options: GovernedListOptions): Promise<MemoryExportResult>;
  quarantine(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
    reason: string,
  ): Promise<MemoryOperationResult>;
  revoke(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
    reason: string,
  ): Promise<MemoryOperationResult>;
  delete(authority: MemoryAuthority, locator: MemoryRecordLocator): Promise<MemoryDeletionResult>;
  forget(authority: MemoryAuthority, request: MemoryForgetRequest): Promise<MemoryForgetResult>;
  placeLegalHold(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
  ): Promise<MemoryLegalHoldResult>;
  releaseLegalHold(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
  ): Promise<MemoryLegalHoldResult>;
  /** Deletes the working memory a run owned, when that run ends. */
  expireWorkingMemory(authority: MemoryAuthority, runId: string): Promise<MemoryRetentionSweep>;
  /**
   * A background retention sweep. `dryRun` reports without deleting; `policy`
   * previews a candidate revision and is rejected outside a dry run.
   */
  sweepRetention(
    authority: MemoryAuthority,
    options?: { readonly dryRun?: boolean; readonly policy?: MemoryGovernancePolicy },
  ): Promise<MemoryRetentionSweep>;
  /**
   * Activates a new instance-wide policy revision; requires `memory:policy`
   * through a chain of governance principals. Rolling back changes future
   * decisions only.
   */
  activatePolicy(
    authority: MemoryAuthority,
    policy: MemoryGovernancePolicy,
  ): Promise<MemoryOperationResult>;
  rollbackPolicy(authority: MemoryAuthority): Promise<MemoryOperationResult>;
  /**
   * Advances every open deletion: resumes an interrupted synchronous lane and
   * settles async targets. It first resolves any derived record a failed or
   * interrupted derivation left hidden, withdrawing it when a source is gone,
   * claimed by a deletion, or no longer active, and activating it otherwise.
   */
  processDeletionPropagation(): Promise<MemoryDeletionReceipt[]>;
  getDeletionReceipt(
    authority: MemoryAuthority,
    deletionId: string,
  ): Promise<MemoryDeletionReceipt | undefined>;
  /** Governance history. Protected reasons and diagnostics are returned only with `memory:inspect`. */
  listEvents(
    authority: MemoryAuthority,
    filter?: { readonly type?: string; readonly recordId?: string },
  ): Promise<MemoryGovernanceEvent[]>;
}
