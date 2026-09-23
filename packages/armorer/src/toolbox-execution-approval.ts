import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ApprovalAdmissionRollback } from './internal/approval-resume';
import { approvalConsumeSymbol } from './internal/approval-resume';
import { signPendingApproval } from './toolbox-approval';
import { issueApprovalStateWithInterruption } from './toolbox-approval-state';
import type { InternalToolExecuteOptionsWithMirror } from './toolbox-contracts';
import type { PendingToolApproval, SignedPendingToolApproval, ToolExecutionResult } from './types';

export type PendingApprovalContext = {
  readonly result: ToolExecutionResult;
  readonly executeOptions: InternalToolExecuteOptionsWithMirror;
  readonly approvalSecret: string | undefined;
  readonly approvalStateStore: Parameters<typeof issueApprovalStateWithInterruption>[0] | undefined;
  readonly runtime: RuntimeServices;
  readonly interruptedResult: (
    approval: SignedPendingToolApproval,
    category: 'cancelled' | 'timeout',
    message: string,
    code: string,
  ) => ToolExecutionResult;
};

export async function processPendingApproval(
  context: PendingApprovalContext,
): Promise<ToolExecutionResult | undefined> {
  const { result, executeOptions, approvalSecret } = context;
  const approval = result.pendingApproval;
  if (!approval) return undefined;
  signPendingApprovalIfConfigured(approval, approvalSecret);
  if (!approval.approvalBinding || !context.approvalStateStore) return undefined;
  if (!requiresApprovalAdmission(approval, executeOptions))
    return issueApprovalState(context, approval);
  return consumeAndIssueApproval(context, approval);
}

function signPendingApprovalIfConfigured(
  approval: PendingToolApproval,
  approvalSecret: string | undefined,
): void {
  if (!approvalSecret) return;
  approval.approvalToken = signPendingApproval(approval, { approvalSecret });
}

function requiresApprovalAdmission(
  approval: PendingToolApproval,
  options: InternalToolExecuteOptionsWithMirror,
): boolean {
  return Boolean(approval.satisfiedPolicyPauses?.length && approvalConsumeSymbol in options);
}

async function consumeAndIssueApproval(
  context: PendingApprovalContext,
  approval: PendingToolApproval,
): Promise<ToolExecutionResult | undefined> {
  const consumeApproval = context.executeOptions[approvalConsumeSymbol];
  const rollback = consumeApproval ? await consumeApproval() : undefined;
  try {
    return await issueApprovalState(context, approval, rollback);
  } catch (error) {
    if (rollback) await rollback();
    throw error;
  }
}

async function issueApprovalState(
  context: PendingApprovalContext,
  approval: PendingToolApproval,
  rollback?: ApprovalAdmissionRollback,
): Promise<ToolExecutionResult | undefined> {
  const token = approval.approvalToken;
  if (typeof token !== 'string') return undefined;
  const signedApproval: SignedPendingToolApproval = { ...approval, approvalToken: token };
  const interrupted = await issueApprovalStateWithInterruption(
    context.approvalStateStore!,
    signedApproval,
    context.executeOptions,
    context.runtime,
    context.interruptedResult,
  );
  if (interrupted && rollback) await rollback();
  return interrupted;
}
