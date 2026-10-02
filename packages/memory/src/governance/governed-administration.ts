import {
  hasMemoryCapability,
  holdsGovernanceAuthority,
  holdsServiceAuthority,
  type MemoryAuthority,
} from './authority';
import type { DeletionEngine } from './deletion';
import { pruneAbandonedDerivations } from './derivation';
import type { GovernanceContext, ResolvedRecord } from './governance-context';
import type {
  MemoryOperationResult,
  MemoryRetentionCandidate,
  MemoryRetentionSweep,
} from './governed-memory-types';
import type { MemoryDeletionReceipt, MemoryGovernanceEvent } from './ledger-types';
import { type MemoryGovernancePolicy, resolveTenantPolicy } from './policy';
import { readRecordGovernance } from './record-governance';
import { retentionExpiry } from './retention';

/**
 * Background retention work runs as a service or governance principal holding
 * explicit retention and deletion capabilities, through a delegation chain of
 * service and governance principals only: nothing a user or a model can reach.
 */
function backgroundAuthorized(authority: MemoryAuthority): boolean {
  return (
    hasMemoryCapability(authority, 'memory:retention') &&
    hasMemoryCapability(authority, 'memory:delete') &&
    holdsServiceAuthority(authority)
  );
}

async function denied(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operationId: string,
  operation: string,
): Promise<void> {
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.access.denied',
    outcome: 'denied',
    attribution: context.attribution(authority, operationId),
    recordIds: [],
    details: { operation },
    reason: 'missing-capability',
  });
}

async function tenantRecords(
  context: GovernanceContext,
  tenantId: string,
): Promise<ResolvedRecord[]> {
  const resolved: ResolvedRecord[] = [];
  for (const scope of await context.ledger.listScopes(tenantId)) {
    for (const record of await context.storage.list(scope)) {
      const read = readRecordGovernance(record);
      if (read !== undefined) resolved.push({ record, read, scope });
    }
  }
  return resolved;
}

function sweepResult(
  operationId: string,
  policyRevision: string,
  overrides: Partial<MemoryRetentionSweep> = {},
): MemoryRetentionSweep {
  return {
    operationId,
    status: 'applied',
    dryRun: false,
    policyRevision,
    expired: [],
    deletionIds: [],
    prunedEvents: 0,
    prunedReceipts: 0,
    ...overrides,
  };
}

async function deleteExpired(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  operationId: string,
  expired: readonly ResolvedRecord[],
): Promise<string[]> {
  const deletionIds: string[] = [];
  // A held record already waiting on its hold keeps its one exempt receipt;
  // every later sweep would otherwise add another.
  const receipts = await context.ledger.listReceipts({ tenantId: authority.tenantId });
  const awaiting = new Set(
    receipts.filter((receipt) => receipt.awaitingHoldRelease).map((receipt) => receipt.record.id),
  );
  for (const resolved of expired) {
    const current = await context.load(resolved.scope.tenantId, {
      id: resolved.record.id,
      namespace: resolved.scope.namespace,
    });
    if (current === undefined || awaiting.has(current.record.id)) continue;
    const receipt = await deletion.requestDeletion({
      attribution: context.attribution(authority, operationId),
      resolved: current,
      trigger: 'retention-expiry',
      scope: current.read.governance.lineage === undefined ? 'source' : 'projection',
    });
    deletionIds.push(receipt.deletionId);
  }
  return deletionIds;
}

async function pruneAudit(
  context: GovernanceContext,
  tenantId: string,
  cutoff: number,
): Promise<{ prunedEvents: number; prunedReceipts: number }> {
  const prunedEvents = await context.ledger.pruneEvents(tenantId, cutoff);
  let prunedReceipts = 0;
  for (const receipt of await context.ledger.listReceipts({ tenantId, open: false })) {
    if (receipt.awaitingHoldRelease || receipt.updatedAt >= cutoff) continue;
    await context.ledger.deleteReceipt(receipt.deletionId);
    prunedReceipts++;
  }
  await pruneAbandonedDerivations(context, tenantId, cutoff);
  return { prunedEvents, prunedReceipts };
}

/**
 * Retention expiry is a deletion: every expired record runs through the same
 * plan and receipt as a requested deletion, and a held record reports every
 * target exempt. A dry run reports what would expire without deleting, which is
 * how a candidate policy revision is inspected before it is activated; a
 * candidate is never applied outside a dry run, so only an activated revision
 * ever deletes. The sweep also prunes audit history older than the tenant's
 * (one-year minimum) audit retention.
 */
export async function sweepRetention(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  options: { readonly dryRun?: boolean; readonly policy?: MemoryGovernancePolicy } = {},
): Promise<MemoryRetentionSweep> {
  const operationId = context.operationId();
  const active = context.policy();
  if (!backgroundAuthorized(authority)) {
    await denied(context, authority, operationId, 'retention.sweep');
    return sweepResult(operationId, active.revision, { status: 'denied' });
  }
  const dryRun = options.dryRun ?? false;
  if (options.policy !== undefined && !dryRun) {
    return sweepResult(operationId, active.revision, {
      status: 'rejected',
      reason: 'candidate-policy-requires-dry-run',
    });
  }
  const policy = options.policy ?? active;
  const tenantPolicy = resolveTenantPolicy(policy, authority.tenantId);
  const now = context.now();
  const expired: ResolvedRecord[] = [];
  const candidates: MemoryRetentionCandidate[] = [];
  for (const resolved of await tenantRecords(context, authority.tenantId)) {
    const expiresAt = retentionExpiry(resolved.read.governance, tenantPolicy.retention);
    if (expiresAt === undefined || expiresAt > now) continue;
    expired.push(resolved);
    candidates.push({
      id: resolved.record.id,
      namespace: resolved.scope.namespace,
      memoryClass: resolved.read.governance.memoryClass,
      expiresAt,
      held: resolved.read.governance.legalHold === 'held',
    });
  }
  const deletionIds = dryRun
    ? []
    : await deleteExpired(context, deletion, authority, operationId, expired);
  const pruned = dryRun
    ? { prunedEvents: 0, prunedReceipts: 0 }
    : await pruneAudit(context, authority.tenantId, now - tenantPolicy.auditReceiptMilliseconds);
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.retention.swept',
    outcome: dryRun ? 'dry-run' : 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds: candidates.map((candidate) => candidate.id),
    details: { policyRevision: policy.revision, ...pruned },
  });
  return sweepResult(operationId, policy.revision, {
    dryRun,
    expired: candidates,
    deletionIds,
    ...pruned,
  });
}

/** Working memory's retention is its run's lifetime: when the run ends, its working records delete. */
export async function expireWorkingMemory(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  runId: string,
): Promise<MemoryRetentionSweep> {
  const operationId = context.operationId();
  const revision = context.policy().revision;
  if (!hasMemoryCapability(authority, 'memory:delete')) {
    await denied(context, authority, operationId, 'retention.working');
    return sweepResult(operationId, revision, { status: 'denied' });
  }
  const now = context.now();
  const records = await tenantRecords(context, authority.tenantId);
  const expired = records.filter(
    ({ read: { governance } }) =>
      governance.memoryClass === 'working' &&
      governance.runId === runId &&
      (governance.ownerId === authority.ownerId || holdsGovernanceAuthority(authority)),
  );
  const deletionIds = await deleteExpired(context, deletion, authority, operationId, expired);
  return sweepResult(operationId, revision, {
    expired: expired.map((resolved) => ({
      id: resolved.record.id,
      namespace: resolved.scope.namespace,
      memoryClass: 'working',
      expiresAt: now,
      held: resolved.read.governance.legalHold === 'held',
    })),
    deletionIds,
  });
}

export interface PolicyHistory {
  current(): MemoryGovernancePolicy;
  activate(
    authority: MemoryAuthority,
    policy: MemoryGovernancePolicy,
  ): Promise<MemoryOperationResult>;
  rollback(authority: MemoryAuthority): Promise<MemoryOperationResult>;
}

/**
 * Policy revisions roll out and roll back through the platform's governance
 * only. The policy is instance-wide — admission and recall detectors, trust
 * floors, retention, and every tenant's overrides — so a tenant's governance
 * principal, which is bound to one tenant, cannot change it: it takes the
 * separate `memory:policy` capability, held through a chain of governance
 * principals only. A rollback changes future admission, recall, retention, and
 * deletion decisions; it never restores anything already revoked or deleted.
 */
export function createPolicyHistory(
  context: () => GovernanceContext,
  initial: MemoryGovernancePolicy,
): PolicyHistory {
  const history: MemoryGovernancePolicy[] = [];
  let current = initial;

  async function change(
    authority: MemoryAuthority,
    next: MemoryGovernancePolicy | undefined,
    type: string,
  ): Promise<MemoryOperationResult> {
    const governance = context();
    const operationId = governance.operationId();
    const authorized =
      hasMemoryCapability(authority, 'memory:policy') && holdsGovernanceAuthority(authority);
    if (!authorized) {
      await denied(governance, authority, operationId, type);
      return { operationId, status: 'denied' };
    }
    if (next === undefined)
      return { operationId, status: 'rejected', reason: 'no-previous-revision' };
    const from = current.revision;
    current = next;
    await governance.recordEvent({
      tenantId: authority.tenantId,
      type,
      outcome: 'applied',
      attribution: governance.attribution(authority, operationId),
      recordIds: [],
      details: { from, to: next.revision },
    });
    return { operationId, status: 'applied' };
  }

  return {
    current: () => current,
    async activate(authority, policy) {
      const previous = current;
      const result = await change(authority, policy, 'memory.policy.activated');
      if (result.status === 'applied') history.push(previous);
      return result;
    },
    async rollback(authority) {
      const result = await change(authority, history.at(-1), 'memory.policy.rolled-back');
      if (result.status === 'applied') history.pop();
      return result;
    },
  };
}

export async function readDeletionReceipt(
  context: GovernanceContext,
  authority: MemoryAuthority,
  deletionId: string,
): Promise<MemoryDeletionReceipt | undefined> {
  const privileged = hasMemoryCapability(authority, 'memory:inspect');
  if (!privileged && !hasMemoryCapability(authority, 'memory:delete')) return undefined;
  const receipt = await context.ledger.getReceipt(deletionId);
  if (receipt?.tenantId !== authority.tenantId) return undefined;
  const mayRead =
    privileged ||
    receipt.record.ownerId === authority.ownerId ||
    holdsGovernanceAuthority(authority);
  return mayRead ? receipt : undefined;
}

/**
 * Governance history. A privileged (`memory:inspect`) read returns everything,
 * including protected reasons and detector diagnostics. A `memory:list` read
 * returns only the caller's own events with those fields removed.
 */
export async function readEvents(
  context: GovernanceContext,
  authority: MemoryAuthority,
  filter: { readonly type?: string; readonly recordId?: string },
): Promise<MemoryGovernanceEvent[]> {
  const events = await context.ledger.listEvents({ tenantId: authority.tenantId, ...filter });
  if (hasMemoryCapability(authority, 'memory:inspect')) return events;
  if (!hasMemoryCapability(authority, 'memory:list')) return [];
  return events
    .filter((event) => event.attribution?.ownerId === authority.ownerId)
    .map(({ reason: _reason, diagnostic: _diagnostic, ...event }) => event);
}
