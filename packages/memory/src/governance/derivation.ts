import { MemoryRecordVersionConflictError } from '../memory-record-storage';
import type { GovernanceContext, ResolvedRecord } from './governance-context';
import type { MemoryPendingDerivation } from './ledger-types';
import type { MemoryRecordSourceReference, RecordGovernance } from './record-governance';

/** Why a record can no longer back a promotion or a derived write. */
export type DerivationBlocker = 'not-found' | 'not-active' | 'deletion-pending';

/**
 * How a derived record's derivation settled. An `active` record was confirmed
 * against its sources and is visible. A `withdrawn` one is gone. A `retained`
 * one lost its sources' backing but is under legal hold, so it stays stored
 * and hidden, and its ledger entry stays until a pass after the release
 * withdraws it.
 */
export type DerivationSettlement =
  | { readonly outcome: 'active' }
  | { readonly outcome: 'withdrawn' | 'retained'; readonly reason: DerivationBlocker };

/**
 * How many times withdrawing a derived record re-reads it and retries after
 * another writer changed it first.
 */
const WITHDRAWAL_ATTEMPTS = 8;

/** Why `governance` can no longer back a derivation, or `undefined` while it can. */
export function derivationBlocker(governance: RecordGovernance): DerivationBlocker | undefined {
  if (governance.state !== 'active') return 'not-active';
  return governance.deletionRequestedAt === undefined ? undefined : 'deletion-pending';
}

/** Re-reads each source: the first reason one no longer backs a derivation, if any. */
async function sourcesBlocker(
  context: GovernanceContext,
  tenantId: string,
  sources: readonly MemoryRecordSourceReference[],
): Promise<DerivationBlocker | undefined> {
  for (const source of sources) {
    const current = await context.load(tenantId, source);
    const blocker =
      current === undefined ? 'not-found' : derivationBlocker(current.read.governance);
    if (blocker !== undefined) return blocker;
  }
  return undefined;
}

function referenceOf(resolved: ResolvedRecord): MemoryRecordSourceReference {
  return { id: resolved.record.id, namespace: resolved.scope.namespace };
}

/**
 * Removes a derived record its sources no longer back. One a deletion already
 * removed needs nothing more, and one under legal hold stays, still hidden.
 * The removal is conditioned on the version just read, so a hold placed in
 * between aborts it and the next attempt finds the hold. Resolves to whether
 * the record is gone.
 */
async function withdraw(context: GovernanceContext, resolved: ResolvedRecord): Promise<boolean> {
  const reference = referenceOf(resolved);
  for (let attempt = 1; ; attempt++) {
    const current = await context.load(resolved.scope.tenantId, reference);
    if (current === undefined) break;
    if (current.read.governance.legalHold === 'held') return false;
    try {
      await context.deleteMany([
        { id: reference.id, scope: resolved.scope, expectedVersion: current.record.version },
      ]);
      break;
    } catch (error) {
      const retry =
        error instanceof MemoryRecordVersionConflictError && attempt < WITHDRAWAL_ATTEMPTS;
      if (!retry) throw error;
    }
  }
  await context.textSearchProvider?.remove(reference.id);
  return true;
}

/**
 * Checks a pending record's sources again and activates it when every one
 * still backs it, or withdraws it otherwise. Revocation stamps a source
 * before it reads what derives from it, and deletion claims a source before
 * it plans, while the record's lineage was written before the record: so
 * whichever runs second sees the other. This check sees the stamp or claim,
 * or the revocation or deletion finds the record through its lineage, and
 * then either stamps it (activation keeps the stamp) or claims it (activation
 * declines).
 */
async function confirm(
  context: GovernanceContext,
  resolved: ResolvedRecord,
): Promise<DerivationSettlement> {
  const sources = resolved.read.governance.lineage?.sources ?? [];
  const blocker = await sourcesBlocker(context, resolved.scope.tenantId, sources);
  const activated = blocker === undefined ? await context.activateDerivation(resolved) : undefined;
  if (activated !== undefined) {
    if (activated.state === 'active' && !activated.indexInvalidated) {
      const { record, scope } = resolved;
      await context.textSearchProvider?.index(record.id, record.content, scope.namespace);
    }
    return { outcome: 'active' };
  }
  const reason = blocker ?? 'deletion-pending';
  return { outcome: (await withdraw(context, resolved)) ? 'withdrawn' : 'retained', reason };
}

/**
 * Settles a stored derived record: a pending one is confirmed or withdrawn,
 * and one already activated is left as it is. Its ledger entry is removed once
 * the record is visible or gone, and kept while a hold retains it hidden.
 */
async function settle(
  context: GovernanceContext,
  resolved: ResolvedRecord,
): Promise<DerivationSettlement> {
  const settlement: DerivationSettlement =
    resolved.read.governance.pendingDerivation === true
      ? await confirm(context, resolved)
      : { outcome: 'active' };
  if (settlement.outcome !== 'retained') {
    await context.ledger.deletePendingDerivation(resolved.scope.tenantId, referenceOf(resolved));
  }
  return settlement;
}

/**
 * Settles the derived record the calling operation has just stored. A record
 * already gone was removed by a deletion that reached it through its lineage.
 * A failure before the record is activated or removed leaves it hidden and
 * its ledger entry in place, for {@link settlePendingDerivations} to resolve.
 */
export async function settleStoredDerivation(
  context: GovernanceContext,
  tenantId: string,
  reference: MemoryRecordSourceReference,
): Promise<DerivationSettlement> {
  const resolved = await context.load(tenantId, reference);
  if (resolved !== undefined) return settle(context, resolved);
  await context.ledger.deletePendingDerivation(tenantId, reference);
  return { outcome: 'withdrawn', reason: 'not-found' };
}

/** Settles one pending entry the way the operation that wrote it would have, and records what it did. */
async function settleEntry(
  context: GovernanceContext,
  entry: MemoryPendingDerivation,
): Promise<void> {
  const resolved = await context.load(entry.tenantId, entry.record);
  if (resolved === undefined) return;
  const { governance } = resolved.read;
  const settlement = await settle(context, resolved);
  if (governance.pendingDerivation !== true || settlement.outcome === 'retained') return;
  const activated = settlement.outcome === 'active';
  await context.recordEvent({
    tenantId: entry.tenantId,
    type: activated ? 'memory.derivation.activated' : 'memory.derivation.withdrawn',
    outcome: activated ? 'applied' : 'withdrawn',
    attribution: governance.attribution,
    recordIds: [
      resolved.record.id,
      ...(governance.lineage?.sources ?? []).map((source) => source.id),
    ],
    ...(settlement.outcome === 'withdrawn' ? { reason: settlement.reason } : {}),
  });
}

/**
 * Resolves every derivation a failure or a crash left pending, as the
 * operation that stored it would have: its record is withdrawn when a source
 * is gone, claimed by a deletion, or no longer active, and activated
 * otherwise. An entry with no stored record is left alone, because nothing
 * tells a record that was never stored from one a derivation still running is
 * about to store; audit retention retires it ({@link pruneAbandonedDerivations}).
 * An entry that cannot settle yet stays, its record still hidden, for the next
 * pass, so it never holds up another entry or the deletions this pass
 * propagates.
 */
export async function settlePendingDerivations(context: GovernanceContext): Promise<void> {
  for (const entry of await context.ledger.listPendingDerivations({})) {
    try {
      await settleEntry(context, entry);
    } catch {
      await context.recordEvent({
        tenantId: entry.tenantId,
        type: 'memory.derivation.deferred',
        outcome: 'pending',
        recordIds: [entry.record.id],
      });
    }
  }
}

/**
 * Retires the ledger entries of derivations that never stored their record:
 * entries older than `before` with no record stored under them. Only an age
 * far past any running operation, the audit retention, tells such an entry
 * from one whose record is still about to be stored.
 */
export async function pruneAbandonedDerivations(
  context: GovernanceContext,
  tenantId: string,
  before: number,
): Promise<void> {
  for (const entry of await context.ledger.listPendingDerivations({ tenantId })) {
    if (entry.startedAt >= before || (await context.load(tenantId, entry.record)) !== undefined) {
      continue;
    }
    await context.ledger.deletePendingDerivation(tenantId, entry.record);
  }
}
