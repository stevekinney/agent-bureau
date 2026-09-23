import type { ReusableApprovalGrant } from './approval-binding';
import type { ToolboxOptions } from './toolbox-contracts';
export type ReusableApprovalGrantInput = Omit<
  ReusableApprovalGrant,
  'version' | 'id' | 'issuedAt' | 'usesRemaining' | 'revoked' | 'signature' | 'policyRevision'
> & { policyRevision?: string };
export type GrantListFilter = { principalId?: string; agentId?: string; toolName?: string };
export type InternalToolboxOptions = Pick<
  ToolboxOptions,
  | 'policy'
  | 'policyContext'
  | 'approvalPolicy'
  | 'approvalSecret'
  | 'approvalStateStore'
  | 'grantStateStore'
  | 'approvalBindingTtlMs'
  | 'approvalNow'
  | 'approvalNonce'
  | 'policyRevision'
  | 'approvalRevision'
  | 'toolboxRevision'
  | 'readOnly'
  | 'allowMutation'
  | 'allowDangerous'
>;
