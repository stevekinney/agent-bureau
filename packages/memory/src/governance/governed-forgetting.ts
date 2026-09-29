import { type MemoryAuthority, holdsGovernanceAuthority } from './authority';
import type { DeletionEngine } from './deletion';
import {
  type GovernanceContext,
  type ResolvedRecord,
  authorizeLocated,
  ownPrivateResource,
  resourceOf,
} from './governance-context';
import type {
  MemoryDeletionResult,
  MemoryForgetMode,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryOperationResult,
  MemoryRecordLocator,
} from './governed-memory-types';
import { evictionContext } from './governed-reads';
import { quarantineRecord } from './governed-transitions';
import { admitWrite, stampInvalidated } from './governed-writes';
import { resolveTenantPolicy } from './policy';
import { decideMemoryAccess } from './predicate';
import { retentionExpiry } from './retention';

type ForgetOf<Mode extends MemoryForgetMode> = Extract<MemoryForgetRequest, { mode: Mode }>;

function tagged(mode: MemoryForgetMode, result: MemoryOperationResult): MemoryForgetResult {
  return { ...result, mode };
}

async function recordForgetting(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operationId: string,
  mode: MemoryForgetMode,
  recordIds: readonly string[],
): Promise<void> {
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.forgotten',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds,
    details: { mode },
  });
}

/** Removes records from one context's future recalls. Nothing is deleted or changed for anyone else. */
async function evictFromContext(
  context: GovernanceContext,
  authority: MemoryAuthority,
  request: ForgetOf<'active-context-eviction'>,
): Promise<MemoryForgetResult> {
  const operationId = context.operationId();
  const allowed = await context.authorize(authority, 'search', ownPrivateResource(authority), {
    operationId,
    recordIds: [],
  });
  if (!allowed.allowed) return tagged(request.mode, allowed.result);
  const evicted: string[] = [];
  for (const locator of request.locators) {
    const resolved = await context.resolve(authority, locator);
    if (
      resolved === undefined ||
      !decideMemoryAccess(authority, 'search', resourceOf(resolved)).allowed
    )
      continue;
    await context.ledger.putEviction(
      authority.tenantId,
      evictionContext(authority, request.contextId),
      locator.id,
    );
    evicted.push(locator.id);
  }
  await recordForgetting(context, authority, operationId, request.mode, evicted);
  return { mode: request.mode, operationId, status: 'applied', recordIds: evicted };
}

async function updateOwnRecord(
  context: GovernanceContext,
  authority: MemoryAuthority,
  mode: MemoryForgetMode,
  locator: MemoryRecordLocator,
  apply: (resolved: ResolvedRecord) => Promise<unknown>,
): Promise<MemoryForgetResult> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'write', locator, operationId);
  if (!('resolved' in located)) return tagged(mode, located.result);
  await apply(located.resolved);
  await recordForgetting(context, authority, operationId, mode, [locator.id]);
  return { mode, operationId, status: 'applied', recordIds: [locator.id] };
}

/**
 * Consolidation replaces several records with one source-linked summary. The
 * summary is an ordinary admitted write derived from its inputs: it is never
 * more trusted than its least trusted input (or than the policy's trust for
 * derived content), it passes the same admission scan, and revoking or deleting
 * any input reaches it. Only an admitted summary takes its inputs out of use.
 */
async function consolidate(
  context: GovernanceContext,
  authority: MemoryAuthority,
  request: ForgetOf<'consolidation'>,
): Promise<MemoryForgetResult> {
  const operationId = context.operationId();
  if (request.locators.length < 2) {
    return { mode: request.mode, operationId, status: 'rejected', reason: 'needs-two-inputs' };
  }
  const write = await admitWrite(context, authority, request.content, {
    collection: request.collection,
    source: 'derived',
    memoryClass: 'semantic',
    derivedFrom: { kind: 'summary', sources: request.locators },
  });
  if (write.status !== 'admitted' && write.status !== 'quarantined') {
    return { mode: request.mode, operationId, status: 'rejected', reason: write.reason!, write };
  }
  if (write.status === 'admitted') {
    for (const locator of request.locators) {
      const input = await context.resolve(authority, locator);
      if (input !== undefined) await stampInvalidated(context, input, write.recordId!);
    }
  }
  await recordForgetting(context, authority, operationId, request.mode, [
    ...request.locators.map((locator) => locator.id),
    write.recordId!,
  ]);
  return {
    mode: request.mode,
    operationId,
    status: 'applied',
    recordIds: [write.recordId!],
    write,
  };
}

/** Supersession keeps the old fact for history but takes it out of active use once an admitted successor exists. */
async function supersede(
  context: GovernanceContext,
  authority: MemoryAuthority,
  request: ForgetOf<'supersession'>,
): Promise<MemoryForgetResult> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'write', request.locator, operationId);
  if (!('resolved' in located)) return tagged(request.mode, located.result);
  if (located.resolved.read.governance.invalidatedAt !== undefined) {
    return { mode: request.mode, operationId, status: 'rejected', reason: 'superseded' };
  }
  const { content, ...options } = request.successor;
  const write = await admitWrite(context, authority, content, options);
  if (write.status !== 'admitted') {
    return {
      mode: request.mode,
      operationId,
      status: 'rejected',
      reason: 'successor-not-admitted',
      write,
    };
  }
  await stampInvalidated(context, located.resolved, write.recordId!);
  await recordForgetting(context, authority, operationId, request.mode, [
    request.locator.id,
    write.recordId!,
  ]);
  return {
    mode: request.mode,
    operationId,
    status: 'applied',
    recordIds: [request.locator.id],
    write,
  };
}

/** Source deletion (or, for a derived record, projection deletion) with a durable receipt. */
export async function deleteLocated(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
  options: { scope?: 'source' | 'projection'; trigger?: 'request' | 'retention-expiry' } = {},
): Promise<MemoryDeletionResult> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'delete', locator, operationId);
  if (!('resolved' in located)) return located.result;
  const derived = located.resolved.read.governance.lineage !== undefined;
  const scope = options.scope ?? (derived ? 'projection' : 'source');
  if (scope === 'projection' && !derived) {
    return { operationId, status: 'rejected', reason: 'not-a-projection' };
  }
  if (scope === 'source' && derived) {
    return { operationId, status: 'rejected', reason: 'not-source-evidence' };
  }
  if (options.trigger === 'retention-expiry') {
    const rules = resolveTenantPolicy(context.policy(), authority.tenantId).retention;
    const expiresAt = retentionExpiry(located.resolved.read.governance, rules);
    if (expiresAt === undefined || expiresAt > context.now()) {
      return { operationId, status: 'rejected', reason: 'not-expired' };
    }
  }
  const receipt = await deletion.requestDeletion({
    attribution: context.attribution(authority, operationId),
    resolved: located.resolved,
    trigger: options.trigger ?? 'request',
    scope,
  });
  return { operationId, status: 'applied', recordIds: [locator.id], receipt };
}

async function revokeExport(
  context: GovernanceContext,
  authority: MemoryAuthority,
  request: ForgetOf<'export-revocation'>,
): Promise<MemoryForgetResult> {
  const operationId = context.operationId();
  const allowed = await context.authorize(authority, 'export', ownPrivateResource(authority), {
    operationId,
    recordIds: [],
  });
  if (!allowed.allowed) return tagged(request.mode, allowed.result);
  const manifest = await context.ledger.getExport(authority.tenantId, request.exportId);
  if (
    manifest === undefined ||
    (manifest.ownerId !== authority.ownerId && !holdsGovernanceAuthority(authority))
  ) {
    return { mode: request.mode, operationId, status: 'not-found' };
  }
  // Merged onto the manifest as stored when the revocation lands, so a
  // deletion scrubbing it meanwhile keeps its removals.
  const revoked = await context.ledger.revokeExport(authority.tenantId, request.exportId, {
    revokedAt: context.now(),
    revokedBy: context.attribution(authority, operationId),
  });
  if (revoked === undefined) return { mode: request.mode, operationId, status: 'unchanged' };
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.export.revoked',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds: revoked.recordIds,
    details: { exportId: revoked.exportId },
  });
  return { mode: request.mode, operationId, status: 'applied', recordIds: revoked.recordIds };
}

/**
 * The forgetting API. Each mode is a different operation with its own
 * semantics: eviction and demotion only change retrieval, consolidation and
 * supersession take records out of active use while keeping their history,
 * quarantine and index invalidation withhold records without deleting them,
 * three modes delete with a receipt, and export revocation withdraws an export.
 */
export async function forget(
  context: GovernanceContext,
  deletion: DeletionEngine,
  authority: MemoryAuthority,
  request: MemoryForgetRequest,
): Promise<MemoryForgetResult> {
  switch (request.mode) {
    case 'active-context-eviction':
      return evictFromContext(context, authority, request);
    case 'retrieval-demotion':
      if (!(request.weight >= 0 && request.weight < 1)) {
        return {
          mode: request.mode,
          operationId: context.operationId(),
          status: 'rejected',
          reason: 'invalid-weight',
        };
      }
      return updateOwnRecord(context, authority, request.mode, request.locator, (resolved) =>
        context.updateGovernance(resolved, { retrievalWeight: request.weight }),
      );
    case 'consolidation':
      return consolidate(context, authority, request);
    case 'supersession':
      return supersede(context, authority, request);
    case 'quarantine':
      return tagged(
        request.mode,
        await quarantineRecord(context, authority, request.locator, request.reason),
      );
    case 'source-deletion':
    case 'projection-deletion':
      return tagged(
        request.mode,
        await deleteLocated(context, deletion, authority, request.locator, {
          scope: request.mode === 'source-deletion' ? 'source' : 'projection',
        }),
      );
    case 'index-invalidation':
      return updateOwnRecord(
        context,
        authority,
        request.mode,
        request.locator,
        async (resolved) => {
          await context.updateGovernance(resolved, { indexInvalidated: true });
          await context.textSearchProvider?.remove(resolved.record.id);
        },
      );
    case 'retention-expiry':
      return tagged(
        request.mode,
        await deleteLocated(context, deletion, authority, request.locator, {
          trigger: 'retention-expiry',
        }),
      );
    case 'export-revocation':
      return revokeExport(context, authority, request);
  }
}
