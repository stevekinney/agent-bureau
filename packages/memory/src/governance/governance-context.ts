import type { Embedder } from '@lostgradient/embeddings';
import type { RuntimeServices } from '@lostgradient/lifecycle';

import {
  type MemoryRecord,
  type MemoryRecordReference,
  type MemoryRecordScope,
  type MemoryRecordStorage,
  MemoryRecordVersionConflictError,
} from '../memory-record-storage';
import type { TextSearchProvider } from '../text-search-provider';
import type { MemoryAuthority, MemoryOperation } from './authority';
import type {
  MemoryDeletionPropagation,
  MemoryGovernanceNotification,
  MemoryOperationResult,
  MemoryOperationStatus,
  MemoryRecordLocator,
} from './governed-memory-types';
import type { MemoryGovernanceLedger } from './ledger';
import type { MemoryGovernanceEvent } from './ledger-types';
import type { MemoryGovernancePolicy } from './policy';
import {
  decideMemoryAccess,
  type MemoryAccessDecision,
  type MemoryDenialReason,
  type MemoryRecordState,
  type MemoryRedaction,
  type MemoryResourceDescriptor,
  type MemoryVisibility,
} from './predicate';
import {
  attributionFor,
  collectionNamespace,
  describeResource,
  type LegalHoldState,
  MEMORY_GOVERNANCE_METADATA_KEY,
  type MemoryAttribution,
  type MemoryRecordSourceReference,
  type ReadRecordGovernance,
  readRecordGovernance,
  type RecordGovernance,
} from './record-governance';

export type TenantScope = Required<MemoryRecordScope>;

export interface ResolvedRecord {
  readonly record: MemoryRecord;
  readonly read: ReadRecordGovernance;
  readonly scope: TenantScope;
}

export type GovernanceEventInput = Omit<MemoryGovernanceEvent, 'id' | 'at'>;

/**
 * The envelope fields an ordinary governance transition may change. Tenant,
 * owner, collection, provenance, trust, lineage, and attribution are fixed at
 * admission; a record's state only ever leaves `active`; the legal hold
 * changes only through {@link GovernanceContext.updateLegalHold}; and a
 * derived record's pending marker is cleared only through
 * {@link GovernanceContext.activateDerivation}.
 */
export type GovernancePatch = Partial<
  Pick<
    RecordGovernance,
    | 'sharedWith'
    | 'retrievalWeight'
    | 'indexInvalidated'
    | 'invalidatedAt'
    | 'supersededBy'
    | 'deletionRequestedAt'
  >
> & { readonly state?: Exclude<MemoryRecordState, 'active'> };

/**
 * A transition: a patch, or a function deciding the patch from the record's
 * current envelope (returning `undefined` when nothing should change).
 */
export type GovernanceChange =
  GovernancePatch | ((current: RecordGovernance) => GovernancePatch | undefined);

/**
 * How many times an envelope transition re-reads and retries after another
 * writer changed the record first. Each retry means some other transition
 * landed, so contention this deep is a fault worth surfacing.
 */
const ENVELOPE_WRITE_ATTEMPTS = 8;

export type AuthorizationOutcome =
  | { readonly allowed: true; readonly decision: Extract<MemoryAccessDecision, { allowed: true }> }
  | { readonly allowed: false; readonly result: MemoryOperationResult };

/**
 * The shared internals every governed operation uses. Not exported from the
 * package: callers reach memory only through {@link GovernedMemory}.
 */
export interface GovernanceContext {
  readonly storage: MemoryRecordStorage;
  readonly deleteMany: (references: readonly MemoryRecordReference[]) => Promise<number>;
  readonly ledger: MemoryGovernanceLedger;
  readonly embedder: Embedder;
  readonly textSearchProvider: TextSearchProvider | undefined;
  readonly runtime: RuntimeServices;
  readonly propagation: MemoryDeletionPropagation;
  policy(): MemoryGovernancePolicy;
  operationId(): string;
  now(): number;
  scope(
    tenantId: string,
    visibility: MemoryVisibility,
    ownerId: string,
    collection: string,
  ): TenantScope;
  locate(authority: MemoryAuthority, locator: MemoryRecordLocator): TenantScope;
  resolve(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
  ): Promise<ResolvedRecord | undefined>;
  load(
    tenantId: string,
    reference: MemoryRecordSourceReference,
  ): Promise<ResolvedRecord | undefined>;
  /**
   * Applies a transition to the record's current envelope, never to the
   * snapshot in `resolved`: the record is re-read, the change is merged onto
   * what is stored now, and the write is a compare-and-swap against the version
   * read, retried when another transition lands first. Returns `false` when the
   * record no longer exists.
   */
  updateGovernance(resolved: ResolvedRecord, change: GovernanceChange): Promise<boolean>;
  /** The one transition that sets a record's legal hold, with the same merge and compare-and-swap. */
  updateLegalHold(resolved: ResolvedRecord, legalHold: LegalHoldState): Promise<boolean>;
  /**
   * The one transition that clears a derived record's `pendingDerivation`
   * marker, with the same merge and compare-and-swap. It declines on a record
   * a deletion has claimed, which then stays hidden until it is removed.
   * Returns the envelope now stored, or `undefined` when the record is gone
   * or claimed.
   */
  activateDerivation(resolved: ResolvedRecord): Promise<RecordGovernance | undefined>;
  attribution(authority: MemoryAuthority, operationId: string): MemoryAttribution;
  recordEvent(event: GovernanceEventInput): Promise<void>;
  authorize(
    authority: MemoryAuthority,
    operation: MemoryOperation,
    resource: MemoryResourceDescriptor,
    context: { operationId: string; recordIds: readonly string[] },
  ): Promise<AuthorizationOutcome>;
}

const HIDDEN_DENIALS: ReadonlySet<MemoryDenialReason> = new Set([
  'tenant-mismatch',
  'not-owner',
  'tampered',
  'pending-derivation',
]);

/**
 * How a denial reads to the caller. Missing a capability says nothing about the
 * resource, so it is reported as `denied`. Tenant, ownership, integrity, and
 * pending-derivation denials are reported exactly like a missing record, so a
 * guessed id or namespace learns nothing. An owner acting on its own record in
 * the wrong state is told why.
 */
export function statusForDenial(reason: MemoryDenialReason): MemoryOperationStatus {
  if (reason === 'missing-capability') return 'denied';
  return HIDDEN_DENIALS.has(reason) ? 'not-found' : 'rejected';
}

export interface CreateGovernanceContextInput {
  readonly storage: MemoryRecordStorage;
  readonly ledger: MemoryGovernanceLedger;
  readonly embedder: Embedder;
  readonly textSearchProvider: TextSearchProvider | undefined;
  readonly runtime: RuntimeServices;
  readonly propagation: MemoryDeletionPropagation;
  readonly policy: () => MemoryGovernancePolicy;
  readonly onEvent:
    ((notification: MemoryGovernanceNotification) => void | Promise<void>) | undefined;
}

export function createGovernanceContext(input: CreateGovernanceContextInput): GovernanceContext {
  const { storage, ledger, runtime, onEvent } = input;
  const deleteMany = storage.deleteMany?.bind(storage);
  if (deleteMany === undefined) {
    throw new Error(
      'Governed memory requires storage.deleteMany: synchronous deletion targets must share one transaction.',
    );
  }

  function scope(
    tenantId: string,
    visibility: MemoryVisibility,
    ownerId: string,
    collection: string,
  ): TenantScope {
    return { tenantId, namespace: collectionNamespace(visibility, ownerId, collection) };
  }

  async function loadFrom(target: TenantScope, id: string): Promise<ResolvedRecord | undefined> {
    const record = await storage.get(id, target);
    if (record === undefined) return undefined;
    const read = readRecordGovernance(record);
    return read === undefined ? undefined : { record, read, scope: target };
  }

  /**
   * Replaces a record's envelope with `next(current)`, where `current` is the
   * envelope stored now, as a compare-and-swap retried when another
   * transition lands first. `next` returning `undefined` leaves it alone.
   */
  async function transition(
    resolved: ResolvedRecord,
    next: (current: RecordGovernance) => RecordGovernance | undefined,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const current = await loadFrom(resolved.scope, resolved.record.id);
      if (current === undefined) return false;
      const envelope = next(current.read.governance);
      if (envelope === undefined) return true;
      const metadata = { ...current.record.metadata, [MEMORY_GOVERNANCE_METADATA_KEY]: envelope };
      try {
        const updated = await storage.update(
          current.record.id,
          current.scope,
          { metadata },
          { expectedVersion: current.record.version },
        );
        return updated !== undefined;
      } catch (error) {
        const retry =
          error instanceof MemoryRecordVersionConflictError && attempt < ENVELOPE_WRITE_ATTEMPTS;
        if (!retry) throw error;
      }
    }
  }

  const context: GovernanceContext = {
    storage,
    deleteMany,
    ledger,
    embedder: input.embedder,
    textSearchProvider: input.textSearchProvider,
    runtime,
    propagation: input.propagation,
    policy: input.policy,
    operationId: () => runtime.identifiers.next('memory-operation'),
    now: () => runtime.clock.now(),
    scope,

    locate(authority, locator) {
      return scope(
        authority.tenantId,
        locator.visibility ?? 'private',
        locator.ownerId ?? authority.ownerId,
        locator.collection,
      );
    },

    async resolve(authority, locator) {
      if (locator.collection.length === 0) return undefined;
      return loadFrom(context.locate(authority, locator), locator.id);
    },

    async load(tenantId, reference) {
      return loadFrom({ tenantId, namespace: reference.namespace }, reference.id);
    },

    updateGovernance(resolved, change) {
      const patchFor = typeof change === 'function' ? change : () => change;
      return transition(resolved, (current) => {
        const patch = patchFor(current);
        return patch === undefined ? undefined : { ...current, ...patch };
      });
    },

    updateLegalHold(resolved, legalHold) {
      return transition(resolved, (current) => ({ ...current, legalHold }));
    },

    async activateDerivation(resolved) {
      let activated: RecordGovernance | undefined;
      const stored = await transition(resolved, (current) => {
        const { pendingDerivation, ...settled } = current;
        activated = current.deletionRequestedAt === undefined ? settled : undefined;
        return pendingDerivation === true && activated !== undefined ? settled : undefined;
      });
      return stored ? activated : undefined;
    },

    attribution(authority, operationId) {
      return attributionFor(authority, {
        governanceRevision: input.policy().revision,
        operationId,
        at: runtime.clock.now(),
      });
    },

    async recordEvent(event) {
      const stored: MemoryGovernanceEvent = {
        ...event,
        id: runtime.identifiers.next('memory-event'),
        at: runtime.clock.now(),
      };
      await ledger.appendEvent(stored);
      const operationId = event.attribution?.operationId ?? event.details?.['operationId'];
      await onEvent?.({
        type: stored.type,
        outcome: stored.outcome,
        tenantId: stored.tenantId,
        at: stored.at,
        recordIds: stored.recordIds,
        ...(typeof operationId === 'string' ? { operationId } : {}),
        ...(event.attribution === undefined
          ? {}
          : {
              principalId: event.attribution.principal.id,
              projection: event.attribution.projection,
            }),
      });
    },

    async authorize(authority, operation, resource, details) {
      const decision = decideMemoryAccess(authority, operation, resource);
      if (decision.allowed) return { allowed: true, decision };
      await context.recordEvent({
        tenantId: authority.tenantId,
        type: 'memory.access.denied',
        outcome: 'denied',
        attribution: context.attribution(authority, details.operationId),
        recordIds: details.recordIds,
        details: { operation },
        reason: decision.reason,
      });
      return {
        allowed: false,
        result: {
          operationId: details.operationId,
          status: statusForDenial(decision.reason),
          ...(statusForDenial(decision.reason) === 'rejected' ? { reason: decision.reason } : {}),
        },
      };
    },
  };
  return context;
}

/** The resource descriptor for a resolved record. */
export function resourceOf(resolved: ResolvedRecord): MemoryResourceDescriptor {
  return describeResource(resolved.read);
}

/** The descriptor a write targets: the caller's own private partition. */
export function ownPrivateResource(authority: MemoryAuthority): MemoryResourceDescriptor {
  return {
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    visibility: 'private',
    state: 'active',
    sharedWith: [],
    integrity: 'intact',
    pendingDerivation: false,
  };
}

/** Authorizes an operation on a record that may not exist, hiding which case applies. */
export async function authorizeLocated(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operation: MemoryOperation,
  locator: MemoryRecordLocator,
  operationId: string,
): Promise<
  { resolved: ResolvedRecord; redaction: MemoryRedaction } | { result: MemoryOperationResult }
> {
  const resolved = await context.resolve(authority, locator);
  if (resolved === undefined) {
    const capabilityCheck = await context.authorize(
      authority,
      operation,
      ownPrivateResource(authority),
      {
        operationId,
        recordIds: [locator.id],
      },
    );
    if (!capabilityCheck.allowed) return { result: capabilityCheck.result };
    return { result: { operationId, status: 'not-found' } };
  }
  const outcome = await context.authorize(authority, operation, resourceOf(resolved), {
    operationId,
    recordIds: [locator.id],
  });
  return outcome.allowed
    ? { resolved, redaction: outcome.decision.redaction }
    : { result: outcome.result };
}
