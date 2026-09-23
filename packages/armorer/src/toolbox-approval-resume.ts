import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  ApprovalBindingError,
  validateApprovalBinding,
  type ApprovalStateStore,
} from './approval-binding';
import type { ToolError, ToolErrorCategory } from './core/errors';
import type { ToolRequestContext } from './execution-context';
import { approvalConsumeSymbol, approvalResumeSymbol } from './internal/approval-resume';
import type { Tool } from './is-tool';
import { verifyAndSnapshotPendingApproval } from './toolbox-approval';
import {
  createApprovalConsumption,
  throwApprovalConsumptionError,
  type ApprovalConsumption,
} from './toolbox-approval-consumption';
import { readApprovalStateWithInterruption } from './toolbox-approval-state';
import type {
  InternalToolboxExecuteOptions,
  ResumeApprovalValidationResult,
  ToolboxExecuteOptions,
} from './toolbox-contracts';
import type { SignedPendingToolApproval, ToolCallInput, ToolExecutionResult } from './types';

export type ApprovalContext = {
  principalId: string;
  tenantId: string;
  ownerId: string;
  authorizationRevision: string;
  capabilitiesRevision: string;
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
  toolboxRevision: string;
  toolDefinitionRevision: string;
  policyRevision: string;
  approvalRevision: string;
};

export type ApprovalResumeContext = {
  readonly approvalSecret: string | undefined;
  readonly approvalStateStore: ApprovalStateStore | undefined;
  readonly approvalNow: () => number;
  readonly toolboxRevision: string;
  readonly policyRevision: string;
  readonly approvalRevision: string;
  readonly runtime: RuntimeServices;
  readonly getTool: (name: string) => Tool | undefined;
  readonly execute: (
    call: ToolCallInput,
    options: InternalToolboxExecuteOptions,
  ) => Promise<ToolExecutionResult>;
  readonly validateArguments: (
    approval: SignedPendingToolApproval,
    validation: Promise<Awaited<ReturnType<Tool['input']['safeParseAsync']>>>,
    options: ToolboxExecuteOptions,
    runtime: RuntimeServices,
  ) => Promise<ResumeApprovalValidationResult>;
  readonly interruptedResult: (
    approval: SignedPendingToolApproval,
    category: ToolErrorCategory,
    message: string,
    code: string,
  ) => ToolExecutionResult;
  readonly createToolError: (
    category: ToolErrorCategory,
    message: string,
    code: string,
    retryable: boolean,
  ) => ToolError;
};

export async function resumeApproval(
  approval: SignedPendingToolApproval,
  resumeOptions: (ToolboxExecuteOptions & { arguments?: unknown }) | undefined,
  context: ApprovalResumeContext,
): Promise<ToolExecutionResult> {
  const verifiedApproval = verifyAndSnapshotPendingApproval(approval, context);
  const preparation = await prepareResume(verifiedApproval, resumeOptions, context);
  if (preparation.status === 'interrupted') return preparation.result;
  const { executeOptions, executeArguments, requestDeadline, currentTool, approvalContext } =
    preparation;
  const validation = await context.validateArguments(
    verifiedApproval,
    currentTool.input.safeParseAsync(executeArguments),
    executeOptions,
    context.runtime,
  );
  if (validation.outcome === 'interrupted') return validation.result;
  if (!validation.parsedArguments.success) throw validation.parsedArguments.error;
  const consumption = createApprovalConsumption(
    verifiedApproval,
    approvalContext,
    executeOptions,
    requestDeadline,
    context,
  );
  return executeResumedCall(
    verifiedApproval,
    executeOptions,
    executeArguments,
    consumption,
    context,
  );
}

async function executeResumedCall(
  approval: SignedPendingToolApproval,
  executeOptions: ToolboxExecuteOptions,
  executeArguments: unknown,
  consumption: ApprovalConsumption | undefined,
  context: ApprovalResumeContext,
): Promise<ToolExecutionResult> {
  const result = await context.execute(
    { id: approval.callId, name: approval.toolName, arguments: executeArguments },
    {
      ...executeOptions,
      ...(consumption ? { [approvalConsumeSymbol]: consumption.consume } : {}),
      [approvalResumeSymbol]: {
        approvedAction: approval.action,
        ...(approval.policyPauseTier !== undefined
          ? { approvedPolicyPauseTier: approval.policyPauseTier }
          : {}),
        proposedArguments: approval.arguments,
        ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
        satisfiedPauses: [
          ...(approval.satisfiedPolicyPauses ?? []),
          {
            action: approval.action,
            ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
            ...(approval.policyPauseTier !== undefined ? { tier: approval.policyPauseTier } : {}),
          },
        ],
      },
    },
  );
  throwApprovalConsumptionError(consumption?.error);
  return consumption?.consumed === undefined
    ? result
    : { ...result, approvalBindingConsumed: consumption.consumed };
}

type ResumePreparation =
  | { status: 'interrupted'; result: ToolExecutionResult }
  | {
      status: 'ready';
      executeOptions: ToolboxExecuteOptions;
      executeArguments: unknown;
      requestDeadline: number | undefined;
      currentTool: Tool;
      approvalContext?: ApprovalContext;
    };

async function prepareResume(
  approval: SignedPendingToolApproval,
  resumeOptions: (ToolboxExecuteOptions & { arguments?: unknown }) | undefined,
  context: ApprovalResumeContext,
): Promise<ResumePreparation> {
  const { executeOptions, executeArguments } = resolveResumeArguments(approval, resumeOptions);
  const requestDeadline = validateResumeDeadline(executeOptions);
  const currentTool = context.getTool(approval.toolName);
  if (!currentTool) throw new Error(`Tool not found: ${approval.toolName}`);
  const stateValidation = await validateApprovalState(
    approval,
    resumeOptions,
    executeOptions,
    currentTool,
    context,
  );
  if (stateValidation.status === 'interrupted') return stateValidation;
  return {
    status: 'ready',
    executeOptions,
    executeArguments,
    requestDeadline,
    currentTool,
    ...(stateValidation.context !== undefined ? { approvalContext: stateValidation.context } : {}),
  };
}

function resolveResumeArguments(
  approval: SignedPendingToolApproval,
  resumeOptions: (ToolboxExecuteOptions & { arguments?: unknown }) | undefined,
): { executeOptions: ToolboxExecuteOptions; executeArguments: unknown } {
  const { arguments: overrideArguments, ...executeOptions } = resumeOptions ?? {};
  return {
    executeOptions,
    executeArguments: Object.prototype.hasOwnProperty.call(resumeOptions ?? {}, 'arguments')
      ? overrideArguments
      : approval.arguments,
  };
}

function validateResumeDeadline(options: ToolboxExecuteOptions): number | undefined {
  const deadline = options.requestContext?.deadline;
  if (deadline !== undefined && !Number.isFinite(deadline)) {
    throw new Error('Execution deadline must be finite.');
  }
  return deadline;
}

async function validateApprovalState(
  approval: SignedPendingToolApproval,
  resumeOptions: ToolboxExecuteOptions | undefined,
  executeOptions: ToolboxExecuteOptions,
  currentTool: Tool,
  context: ApprovalResumeContext,
): Promise<
  | { status: 'ready'; context?: ApprovalContext }
  | { status: 'interrupted'; result: ToolExecutionResult }
> {
  if (!context.approvalStateStore) return { status: 'ready' };
  const { requestContext, binding } = requireApprovalRequest(resumeOptions, approval);
  const approvalContext: ApprovalContext = {
    principalId: requestContext.authority.principalId,
    tenantId: requestContext.authority.tenantId,
    ownerId: requestContext.authority.ownerId,
    authorizationRevision: requestContext.authority.authorizationRevision,
    capabilitiesRevision: JSON.stringify([...requestContext.authority.capabilities].toSorted()),
    audience: requestContext.audience,
    agentId: requestContext.agentId,
    runId: requestContext.runId,
    toolboxRevision: context.toolboxRevision,
    toolDefinitionRevision: currentTool.id,
    policyRevision: context.policyRevision,
    approvalRevision: context.approvalRevision,
  };
  validateApprovalBinding(binding, approvalContext, context.approvalNow());
  const stateResult = await readApprovalStateWithInterruption(
    context.approvalStateStore,
    binding,
    approval,
    executeOptions,
    context.runtime,
    context.interruptedResult,
  );
  return ensureApprovalState(stateResult, approvalContext);
}

function requireApprovalRequest(
  resumeOptions: ToolboxExecuteOptions | undefined,
  approval: SignedPendingToolApproval,
): {
  requestContext: RequiredApprovalRequestContext;
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>;
} {
  const requestContext = resumeOptions?.requestContext;
  if (
    !requestContext?.agentId ||
    !requestContext.runId ||
    !requestContext.audience ||
    !approval.approvalBinding
  ) {
    throw new Error('Request context and approval binding are required.');
  }
  return {
    requestContext: {
      ...requestContext,
      audience: requestContext.audience,
      agentId: requestContext.agentId,
      runId: requestContext.runId,
    },
    binding: approval.approvalBinding,
  };
}

type RequiredApprovalRequestContext = Omit<
  NonNullable<ToolboxExecuteOptions['requestContext']>,
  'audience' | 'agentId' | 'runId'
> & {
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
};

function ensureApprovalState(
  stateResult: Awaited<ReturnType<typeof readApprovalStateWithInterruption>>,
  approvalContext: ApprovalContext,
): Promise<
  | { status: 'ready'; context: ApprovalContext }
  | { status: 'interrupted'; result: ToolExecutionResult }
> {
  if (stateResult.outcome === 'interrupted') {
    return Promise.resolve({ status: 'interrupted', result: stateResult.result });
  }
  if (stateResult.state === undefined) {
    throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
  }
  if (stateResult.state === 'revoked') {
    throw new ApprovalBindingError('Approval binding was revoked.', 'revoked');
  }
  if (stateResult.state === 'consumed') {
    throw new ApprovalBindingError(
      'Approval binding has already been consumed.',
      'already-consumed',
    );
  }
  return Promise.resolve({ status: 'ready', context: approvalContext });
}
