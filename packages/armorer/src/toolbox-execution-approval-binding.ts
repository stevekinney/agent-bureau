import type { ApprovalStateStore } from './approval-binding';
import { stableStringifyJson } from './core/serialization/json';
import type { Tool } from './is-tool';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { ToolExecutionResult } from './types';

export type PendingApprovalBindingContext = {
  readonly result: ToolExecutionResult;
  readonly tool: Tool;
  readonly options: ToolboxExecuteOptions;
  readonly approvalSecret: string | undefined;
  readonly approvalStateStore: ApprovalStateStore | undefined;
  readonly approvalNow: () => number;
  readonly approvalBindingTtlMs: number;
  readonly approvalNonce: () => string;
  readonly toolboxRevision: string;
  readonly policyRevision: string;
  readonly approvalRevision: string;
};

export function bindPendingApproval(context: PendingApprovalBindingContext): void {
  const { result, tool, options, approvalSecret, approvalStateStore } = context;
  if (!result.pendingApproval || !approvalSecret || !approvalStateStore) return;
  const validatedContext = validateBindingInputs(tool, options.requestContext);
  const { requestContext, agentId, runId, audience } = validatedContext;
  const issuedAt = context.approvalNow();
  const expiresAt = issuedAt + context.approvalBindingTtlMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('approvalBindingTtlMs produces an invalid approval expiry.');
  }
  result.pendingApproval.approvalBinding = {
    version: 1,
    principalId: requestContext.authority.principalId,
    tenantId: requestContext.authority.tenantId,
    ownerId: requestContext.authority.ownerId,
    authorizationRevision: requestContext.authority.authorizationRevision,
    capabilitiesRevision: stableStringifyJson(
      [...requestContext.authority.capabilities].toSorted(),
    ),
    audience,
    agentId,
    runId,
    toolboxRevision: context.toolboxRevision,
    toolDefinitionRevision: tool.id,
    policyRevision: context.policyRevision,
    approvalRevision: context.approvalRevision,
    issuedAt,
    expiresAt,
    nonce: context.approvalNonce(),
    replayScope: `${requestContext.authority.tenantId}:${requestContext.runId}`,
  };
}

function validateBindingInputs(
  tool: Tool,
  requestContext: ToolboxExecuteOptions['requestContext'],
): {
  requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>;
  agentId: string;
  runId: string;
  audience: NonNullable<NonNullable<ToolboxExecuteOptions['requestContext']>['audience']>;
} {
  if (!requestContext) {
    throw new Error(
      'Approval authorization requires request principal, tenant, audience, agentId, and runId.',
    );
  }
  const { agentId, runId, audience } = requestContext;
  if (!agentId || !runId || !audience) {
    throw new Error(
      'Approval authorization requires request principal, tenant, audience, agentId, and runId.',
    );
  }
  if (!tool.identity.version) {
    throw new Error(
      `Approval authorization requires a versioned tool definition for "${tool.name}".`,
    );
  }
  return { requestContext, agentId, runId, audience };
}
