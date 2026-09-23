import { hmacSha256HexSync, timingSafeEqualHex } from '@lostgradient/cryptography';
import {
  ApprovalBindingError,
  type ApprovalStateStore,
  GRANT_VERSION,
  GrantError,
  type GrantStateStore,
  type ReusableApprovalGrant,
  signGrant,
  validateApprovalBinding,
} from './approval-binding';
import { assertJsonValue, type JsonValue, stableStringifyJson } from './core/serialization/json';
import type { Tool } from './is-tool';
import type { GrantListFilter, ReusableApprovalGrantInput } from './toolbox-approval-contracts';
import type { PendingToolApproval, SignedPendingToolApproval } from './types';

export type ApprovalTokenContext = { readonly approvalSecret: string | undefined };

export function signPendingApproval(
  approval: PendingToolApproval,
  context: ApprovalTokenContext,
): string {
  if (!context.approvalSecret) {
    throw new Error('Toolbox approvalSecret is required to sign pending approvals.');
  }
  return hmacSha256HexSync(
    context.approvalSecret,
    stableStringifyJson(normalizePendingApprovalPayload(approval)),
  );
}

export function verifyPendingApproval(
  approval: SignedPendingToolApproval,
  context: ApprovalTokenContext,
): void {
  if (!context.approvalSecret) {
    throw new Error('Toolbox approvalSecret is required to resume signed pending approvals.');
  }
  if (
    !approval ||
    typeof approval.approvalToken !== 'string' ||
    !timingSafeEqualHex(approval.approvalToken, signPendingApproval(approval, context))
  ) {
    throw new Error('Pending approval descriptor is missing or has an invalid approval token.');
  }
}

export function verifyAndSnapshotPendingApproval(
  approval: SignedPendingToolApproval,
  context: ApprovalTokenContext,
): SignedPendingToolApproval {
  const snapshot: unknown = JSON.parse(JSON.stringify(approval));
  assertJsonValue(snapshot, 'approval');
  const signedSnapshot = snapshot as SignedPendingToolApproval;
  verifyPendingApproval(signedSnapshot, context);
  return signedSnapshot;
}

function normalizePendingApprovalPayload(approval: PendingToolApproval): JsonValue {
  const { approvalToken: _approvalToken, ...payload } = approval;
  const parsed: unknown = JSON.parse(JSON.stringify(payload));
  assertJsonValue(parsed, 'approval');
  return parsed;
}

export type GrantContext = {
  readonly approvalSecret: string | undefined;
  readonly grantStateStore: GrantStateStore | undefined;
  readonly approvalNonce: () => string;
  readonly approvalNow: () => number;
  readonly policyRevision: string;
};

export async function issueGrant(
  input: ReusableApprovalGrantInput,
  context: GrantContext,
): Promise<ReusableApprovalGrant> {
  if (!context.approvalSecret || !context.grantStateStore) {
    throw new Error('Toolbox approvalSecret is required to issue reusable approval grants.');
  }
  validateGrantScope(input);
  const unsigned: ReusableApprovalGrant = {
    ...input,
    version: GRANT_VERSION,
    id: `grant:${context.approvalNonce()}`,
    issuedAt: context.approvalNow(),
    usesRemaining: input.maxUses,
    revoked: false,
    policyRevision: input.policyRevision ?? context.policyRevision,
    signature: '',
  };
  const signed = { ...unsigned, signature: signGrant(unsigned, context.approvalSecret) };
  await context.grantStateStore.issue(signed);
  return signed;
}

function validateGrantScope(input: ReusableApprovalGrantInput): void {
  if (input.scope === 'run' && !input.runId) {
    throw new GrantError('A "run"-scoped grant requires a runId.', 'invalid-scope');
  }
  if (input.scope === 'session' && !input.sessionId) {
    throw new GrantError('A "session"-scoped grant requires a sessionId.', 'invalid-scope');
  }
}

export async function revokeGrant(id: string, store: GrantStateStore | undefined): Promise<void> {
  if (!store) throw new Error('Grant state store is required to revoke reusable approval grants.');
  await store.revoke(id);
}

export async function listGrants(
  filter: GrantListFilter | undefined,
  store: GrantStateStore | undefined,
): Promise<ReusableApprovalGrant[]> {
  if (!store) throw new Error('Grant state store is required to list reusable approval grants.');
  const grants = await store.list();
  return filter ? grants.filter((grant) => matchesGrantFilter(grant, filter)) : grants;
}

function matchesGrantFilter(grant: ReusableApprovalGrant, filter: GrantListFilter): boolean {
  return (
    (filter.principalId === undefined || grant.principalId === filter.principalId) &&
    (filter.agentId === undefined || grant.agentId === filter.agentId) &&
    (filter.toolName === undefined || grant.toolName === filter.toolName)
  );
}

export type ApprovalRestoreContext = {
  readonly approvalStateStore: ApprovalStateStore | undefined;
  readonly approvalSecret: string | undefined;
  readonly approvalNow: () => number;
  readonly toolboxRevision: string;
  readonly policyRevision: string;
  readonly approvalRevision: string;
  readonly getTool: (name: string) => Tool | undefined;
};

export async function revokeApproval(
  approval: SignedPendingToolApproval,
  context: ApprovalRestoreContext,
): Promise<void> {
  verifyPendingApproval(approval, context);
  if (!context.approvalStateStore || !approval.approvalBinding) {
    throw new Error('Approval state store and binding are required to revoke an approval.');
  }
  await context.approvalStateStore.revoke(approval.approvalBinding);
}

export async function restoreApproval(
  approval: SignedPendingToolApproval,
  context: ApprovalRestoreContext,
): Promise<void> {
  verifyPendingApproval(approval, context);
  const store = context.approvalStateStore;
  const binding = approval.approvalBinding;
  if (!store || !binding) {
    throw new Error('Approval state store and binding are required to restore approvals.');
  }
  const currentTool = context.getTool(approval.toolName);
  validateApprovalBinding(binding, undefined, context.approvalNow());
  assertCurrentBinding(binding, currentTool, context);
  await restoreBindingState(store, binding);
}

function assertCurrentBinding(
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
  currentTool: Tool | undefined,
  context: ApprovalRestoreContext,
): void {
  const staleRevisions = [
    binding.toolboxRevision !== context.toolboxRevision ? 'toolboxRevision' : undefined,
    binding.toolDefinitionRevision !== currentTool?.id ? 'toolDefinitionRevision' : undefined,
    binding.policyRevision !== context.policyRevision ? 'policyRevision' : undefined,
    binding.approvalRevision !== context.approvalRevision ? 'approvalRevision' : undefined,
  ].filter((revision): revision is string => revision !== undefined);
  if (staleRevisions.length > 0) {
    throw new ApprovalBindingError(
      `Cannot restore approval binding with stale ${staleRevisions.join(', ')}.`,
      'invalid-binding',
    );
  }
}

async function restoreBindingState(
  store: ApprovalStateStore,
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
): Promise<void> {
  const state = await store.state(binding);
  if (state === undefined) {
    await issueIfConcurrent(store, binding);
    return;
  }
  if (state !== 'issued') {
    const errorCode = state === 'consumed' ? 'already-consumed' : 'revoked';
    throw new ApprovalBindingError(`Cannot restore ${state} approval binding.`, errorCode);
  }
}

async function issueIfConcurrent(
  store: ApprovalStateStore,
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
): Promise<void> {
  try {
    await store.issue(binding);
  } catch (error) {
    if ((await store.state(binding)) === 'issued') return;
    throw error;
  }
}
