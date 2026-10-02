import { hasMemoryCapability, holdsGovernanceAuthority, type MemoryAuthority } from './authority';
import { scanGovernedContent } from './content-scan';
import { type DeletionEngine, planReferences } from './deletion';
import {
  authorizeLocated,
  type GovernanceContext,
  type ResolvedRecord,
} from './governance-context';
import type {
  MemoryLegalHoldResult,
  MemoryOperationResult,
  MemoryRecordLocator,
} from './governed-memory-types';
import { storeGovernedRecord } from './governed-writes';
import type { MemoryRecordState } from './predicate';
import { type MemoryRecordSourceReference, withoutReservedMetadata } from './record-governance';

/** Every record transitively derived from `source`, via the ledger's lineage index. */
export async function derivedRecords(
  context: GovernanceContext,
  tenantId: string,
  source: MemoryRecordSourceReference,
): Promise<ResolvedRecord[]> {
  const found: ResolvedRecord[] = [];
  const seen = new Set([JSON.stringify([source.namespace, source.id])]);
  const queue = [source];
  for (let reference = queue.shift(); reference !== undefined; reference = queue.shift()) {
    for (const link of await context.ledger.listLineage(tenantId, reference)) {
      const key = JSON.stringify([link.derived.namespace, link.derived.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(link.derived);
      const resolved = await context.load(tenantId, link.derived);
      if (resolved !== undefined) found.push(resolved);
    }
  }
  return found;
}

function referenceOf(resolved: ResolvedRecord): MemoryRecordSourceReference {
  return { id: resolved.record.id, namespace: resolved.scope.namespace };
}

function keyOf(resolved: ResolvedRecord): string {
  return JSON.stringify([resolved.scope.namespace, resolved.record.id]);
}

/** Moves one record to `state`; true when this call changed its stored envelope. */
async function stamp(
  context: GovernanceContext,
  resolved: ResolvedRecord,
  state: Exclude<MemoryRecordState, 'active'>,
): Promise<boolean> {
  let patched = false;
  // Decided against the envelope as it is now: a revocation that landed
  // meanwhile is never downgraded to quarantine.
  const stored = await context.updateGovernance(resolved, (governance) => {
    patched = governance.state !== 'revoked' && governance.state !== state;
    return patched ? { state } : undefined;
  });
  return stored && patched;
}

async function setState(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  state: Exclude<MemoryRecordState, 'active'>,
  reason: string,
): Promise<MemoryOperationResult> {
  const operationId = context.operationId();
  const operation = state === 'revoked' ? 'revoke' : 'quarantine';
  const located = await authorizeLocated(context, authority, operation, locator, operationId);
  if (!('resolved' in located)) return located.result;
  // The source is stamped before anything derived from it is read, and the
  // lineage is read again after each round of stamps until a read finds
  // nothing new. A derivation re-checks its source once its record is stored
  // and linked: after the stamp it withdraws itself; before it, its link is
  // already there for the next read to find. The whole lineage is stamped even
  // when the source already carries the state, so running a transition again
  // finishes one that failed partway; the stamps are idempotent, and only a
  // transition that changed no record reports `unchanged`.
  const affected: ResolvedRecord[] = [];
  const stamped = new Set<string>();
  let changed = false;
  let round: ResolvedRecord[] = [located.resolved];
  while (round.length > 0) {
    for (const resolved of round) {
      stamped.add(keyOf(resolved));
      affected.push(resolved);
      if (await stamp(context, resolved, state)) changed = true;
      await context.textSearchProvider?.remove(resolved.record.id);
    }
    const derived = await derivedRecords(
      context,
      authority.tenantId,
      referenceOf(located.resolved),
    );
    round = derived.filter((resolved) => !stamped.has(keyOf(resolved)));
  }
  if (!changed) return { operationId, status: 'unchanged', recordIds: [locator.id] };
  const recordIds = affected.map((resolved) => resolved.record.id);
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: state === 'revoked' ? 'memory.revoked' : 'memory.quarantined',
    outcome: state,
    attribution: context.attribution(authority, operationId),
    recordIds,
    reason,
  });
  return { operationId, status: 'applied', recordIds };
}

/**
 * Quarantine removes a record, and everything derived from it, from ordinary use
 * pending inspection. It does not block deletion; a legal hold is the
 * independent axis that does. Quarantining again finishes a quarantine that
 * failed partway.
 */
export function quarantineRecord(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  reason: string,
): Promise<MemoryOperationResult> {
  return setState(context, authority, locator, 'quarantined', reason);
}

/**
 * Revocation withdraws authorization for a record and everything derived from
 * it while retaining them for audit. No transition makes a revoked record active
 * again; restoring it takes a new, separately authorized write. Revoking again
 * finishes a revocation that failed partway.
 */
export function revokeRecord(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  reason: string,
): Promise<MemoryOperationResult> {
  return setState(context, authority, locator, 'revoked', reason);
}

/**
 * Promotion to shared Bureau memory: a separately authorized (`memory:promote`)
 * transition that verifies the record — active, intact, not superseded, not
 * claimed by a deletion, and clean under the admission detectors — before
 * creating a shared canonical projection with provenance. The shared copy is
 * linked to its source, so revoking or deleting the source reaches it, and the
 * promoter can revoke it. The copy stays hidden until its source has been
 * checked again: a source revoked, deleted, or claimed by a deletion while the
 * copy was being published withdraws the copy, and the promotion does not
 * happen.
 */
export async function promoteRecord(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  options: { readonly collection?: string } = {},
): Promise<MemoryOperationResult & { readonly sharedId?: string }> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'promote', locator, operationId);
  if (!('resolved' in located)) return located.result;
  const { record, read } = located.resolved;
  const { governance } = read;
  if (governance.invalidatedAt !== undefined) {
    return { operationId, status: 'rejected', reason: 'superseded' };
  }
  if (governance.deletionRequestedAt !== undefined) {
    return { operationId, status: 'rejected', reason: 'deletion-pending' };
  }
  const scan = await scanGovernedContent(
    record.content,
    context.policy().admission.detectors,
    'user-input',
  );
  if (scan.flagged) {
    const { flagged: _flagged, ...diagnostic } = scan;
    await context.recordEvent({
      tenantId: authority.tenantId,
      type: 'memory.promotion.rejected',
      outcome: 'rejected',
      attribution: context.attribution(authority, operationId),
      recordIds: [record.id],
      reason: 'verification-failed',
      diagnostic: { ...diagnostic, contentDigest: governance.contentDigest },
    });
    return { operationId, status: 'rejected', reason: 'verification-failed' };
  }
  const collection = options.collection ?? governance.collection;
  const sharedScope = context.scope(authority.tenantId, 'shared', authority.ownerId, collection);
  const { dedupeKey: _dedupeKey, ...metadata } = withoutReservedMetadata(record.metadata);
  // The copy is stored hidden, after its pending entry and lineage link, and
  // published only once its source has been checked again. A revocation or
  // deletion running alongside either finds the link or is seen by that
  // check; a failure or crash before publication leaves a hidden copy that
  // the next propagation pass withdraws or publishes. No reader ever sees a
  // copy of content its owner has deleted or revoked.
  const stored = await storeGovernedRecord(context, {
    authority,
    operationId,
    content: record.content,
    options: {
      collection,
      source: governance.source,
      memoryClass: governance.memoryClass,
      eventAt: governance.eventAt,
      metadata,
    },
    scope: sharedScope,
    trust: governance.trust,
    state: 'active',
    visibility: 'shared',
    lineage: { kind: 'canonical-projection', sources: [referenceOf(located.resolved)] },
    vector: record.vector,
  });
  if (stored.outcome === 'withdrawn') {
    await context.recordEvent({
      tenantId: authority.tenantId,
      type: 'memory.promotion.rejected',
      outcome: 'rejected',
      attribution: context.attribution(authority, operationId),
      recordIds: [record.id],
      reason: stored.reason,
    });
    return stored.reason === 'not-found'
      ? { operationId, status: 'not-found' }
      : { operationId, status: 'rejected', reason: stored.reason };
  }
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.promoted',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds: [record.id, stored.record.id],
    details: { sharedCollection: collection },
  });
  return {
    operationId,
    status: 'applied',
    sharedId: stored.record.id,
    recordIds: [record.id, stored.record.id],
  };
}

/** Grants (or withdraws) another owner `get` access to one private record. */
export async function changeShare(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  granteeOwnerId: string,
  grant: boolean,
): Promise<MemoryOperationResult> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'share', locator, operationId);
  if (!('resolved' in located)) return located.result;
  if (granteeOwnerId.length === 0 || granteeOwnerId === authority.ownerId) {
    return { operationId, status: 'rejected', reason: 'invalid-grantee' };
  }
  if (located.resolved.read.governance.sharedWith.includes(granteeOwnerId) === grant) {
    return { operationId, status: 'unchanged', recordIds: [locator.id] };
  }
  // Computed from the grantees stored now, so concurrent grants all survive.
  await context.updateGovernance(located.resolved, ({ sharedWith }) =>
    sharedWith.includes(granteeOwnerId) === grant
      ? undefined
      : {
          sharedWith: grant
            ? [...sharedWith, granteeOwnerId]
            : sharedWith.filter((id) => id !== granteeOwnerId),
        },
  );
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: grant ? 'memory.shared' : 'memory.share.revoked',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds: [locator.id],
    details: { grantee: granteeOwnerId },
  });
  return { operationId, status: 'applied', recordIds: [locator.id] };
}

/**
 * COR-806: only a privileged governance principal may place or lift a legal
 * hold: its whole delegation chain is governance, so no user, Agent, run, or
 * tool upstream can lend it that privilege.
 */
function holdAuthorized(authority: MemoryAuthority): boolean {
  return hasMemoryCapability(authority, 'memory:legal-hold') && holdsGovernanceAuthority(authority);
}

export async function changeLegalHold(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  place: boolean,
): Promise<MemoryLegalHoldResult> {
  const operationId = context.operationId();
  if (!holdAuthorized(authority)) {
    await context.recordEvent({
      tenantId: authority.tenantId,
      type: 'memory.access.denied',
      outcome: 'denied',
      attribution: context.attribution(authority, operationId),
      recordIds: [locator.id],
      details: { operation: place ? 'legal-hold.place' : 'legal-hold.release' },
      reason: 'legal-hold-authority',
    });
    return { operationId, status: 'denied' };
  }
  const resolved = await context.resolve(authority, locator);
  if (resolved === undefined) return { operationId, status: 'not-found' };
  const current = resolved.read.governance.legalHold;
  if ((place && current === 'held') || (!place && current !== 'held')) {
    return { operationId, status: 'unchanged', recordIds: [locator.id] };
  }
  // A record deleted since it was resolved holds nothing: report it missing
  // rather than claim a hold that protects no record.
  if (!(await context.updateLegalHold(resolved, place ? 'held' : 'released'))) {
    return { operationId, status: 'not-found' };
  }
  const requeued: string[] = [];
  if (!place) {
    const waiting = await context.ledger.listReceipts({ tenantId: authority.tenantId });
    for (const receipt of waiting) {
      const covers =
        receipt.record.id === locator.id ||
        planReferences(receipt.plan).some((reference) => reference.id === locator.id);
      if (!receipt.awaitingHoldRelease || !covers) continue;
      const next = await deletion.requeueAfterRelease(receipt);
      if (next !== undefined) requeued.push(next.deletionId);
    }
  }
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: place ? 'memory.legal-hold.placed' : 'memory.legal-hold.released',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds: [locator.id],
    details: { requeued: requeued.length },
  });
  return {
    operationId,
    status: 'applied',
    recordIds: [locator.id],
    ...(place ? {} : { requeued }),
  };
}
