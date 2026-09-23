import type { RuntimeServices } from '@lostgradient/lifecycle';

import type {
  ApprovalBindingContext,
  ApprovalStateStore,
  GrantStateStore,
  ReusableApprovalGrant,
} from './approval-binding';
import type { ToolError } from './core/errors';
import { assertJsonValue } from './core/serialization/json';
import { freezeToolRequestContext, type ToolRequestContext } from './execution-context';
import type { Tool } from './is-tool';
import {
  issueGrant,
  listGrants,
  restoreApproval,
  revokeApproval,
  revokeGrant,
  verifyAndSnapshotPendingApproval,
} from './toolbox-approval';
import type { GrantListFilter, ReusableApprovalGrantInput } from './toolbox-approval-contracts';
import { resumeApproval as resumeApprovalOwner } from './toolbox-approval-resume';
import {
  createInterruptedResumeApprovalValidationResult,
  validateResumedApprovalArguments,
} from './toolbox-approval-validation';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import type {
  JSONValue,
  SignedPendingToolApproval,
  ToolApprovalResolution,
  ToolCallInput,
  ToolExecutionResult,
} from './types';

export type ToolboxResolveApprovalOptions = Omit<ToolboxExecuteOptions, 'requestContext'> & {
  requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>;
};

type ToolboxExecuteReceiver = {
  execute: (call: ToolCallInput, options?: ToolboxExecuteOptions) => Promise<ToolExecutionResult>;
};

export type ToolboxApprovalApi = Omit<
  Pick<
    Toolbox,
    | 'resumeApproval'
    | 'resolveApproval'
    | 'restoreApproval'
    | 'revokeApproval'
    | 'issueGrant'
    | 'revokeGrant'
    | 'listGrants'
  >,
  'resumeApproval' | 'resolveApproval'
> & {
  resumeApproval(
    this: ToolboxExecuteReceiver,
    approval: SignedPendingToolApproval,
    options?: ToolboxExecuteOptions & { arguments?: unknown },
  ): Promise<ToolExecutionResult>;
  resolveApproval(
    this: ToolboxExecuteReceiver,
    approval: SignedPendingToolApproval,
    resolution: ToolApprovalResolution,
    options: ToolboxResolveApprovalOptions,
  ): Promise<ToolExecutionResult>;
};

type ToolboxApprovalContext = {
  approvalSecret: string | undefined;
  approvalStateStore: ApprovalStateStore | undefined;
  grantStateStore: GrantStateStore | undefined;
  approvalNow: () => number;
  approvalNonce: () => string;
  toolboxRevision: string;
  policyRevision: string;
  approvalRevision: string;
  runtime: RuntimeServices;
  getTool: (name: string) => Tool | undefined;
  execute: (call: ToolCallInput, options?: ToolboxExecuteOptions) => Promise<ToolExecutionResult>;
  createToolError: (
    category: ToolError['category'],
    message: string,
    code: string,
    retryable: boolean,
  ) => ToolError;
};

export function createToolboxApprovalApi(context: ToolboxApprovalContext): ToolboxApprovalApi {
  async function resumeApproval(
    receiver: ToolboxExecuteReceiver | undefined,
    approval: SignedPendingToolApproval,
    resumeOptions?: ToolboxExecuteOptions & { arguments?: unknown },
  ): Promise<ToolExecutionResult> {
    return resumeApprovalOwner(approval, resumeOptions, {
      approvalSecret: context.approvalSecret,
      approvalStateStore: context.approvalStateStore,
      approvalNow: context.approvalNow,
      toolboxRevision: context.toolboxRevision,
      policyRevision: context.policyRevision,
      approvalRevision: context.approvalRevision,
      runtime: context.runtime,
      getTool: context.getTool,
      execute: (call, executeOptions) =>
        receiver && typeof receiver.execute === 'function'
          ? receiver.execute(call, executeOptions)
          : context.execute(call, executeOptions),
      validateArguments: (pendingApproval, validation, validationOptions, validationRuntime) =>
        validateResumedApprovalArguments(
          pendingApproval,
          validation,
          validationOptions,
          validationRuntime,
          createInterruptedResumeApprovalValidationResult,
        ),
      interruptedResult: createInterruptedResumeApprovalValidationResult,
      createToolError: context.createToolError,
    });
  }

  async function resolveApproval(
    receiver: ToolboxExecuteReceiver | undefined,
    approval: SignedPendingToolApproval,
    resolution: ToolApprovalResolution,
    options: ToolboxResolveApprovalOptions,
  ): Promise<ToolExecutionResult> {
    const normalizedResolution = normalizeResolution(resolution);
    const verifiedApproval = verifyAndSnapshotPendingApproval(approval, context);
    if (verifiedApproval.action.type !== 'approval') {
      throw new Error('Approval resolution requires an approval action.');
    }
    const resolveOptions = snapshotResolveOptions(options);
    if (normalizedResolution.decision === 'approve') {
      return resumeApproval(receiver, verifiedApproval, resolveOptions);
    }
    if (normalizedResolution.decision === 'approve_with_edits') {
      return resumeApproval(receiver, verifiedApproval, {
        ...resolveOptions,
        arguments: normalizedResolution.editedArgs,
      });
    }
    if (isRejectionResolution(normalizedResolution)) {
      return rejectApproval(verifiedApproval, normalizedResolution, resolveOptions, context);
    }
    throw new Error('Approval resolution decision is invalid.');
  }

  return {
    resumeApproval(approval, options) {
      return resumeApproval(this, approval, options);
    },
    resolveApproval(approval, resolution, options) {
      return resolveApproval(this, approval, resolution, options);
    },
    restoreApproval: (approval) =>
      restoreApproval(approval, {
        approvalStateStore: context.approvalStateStore,
        approvalSecret: context.approvalSecret,
        approvalNow: context.approvalNow,
        toolboxRevision: context.toolboxRevision,
        policyRevision: context.policyRevision,
        approvalRevision: context.approvalRevision,
        getTool: context.getTool,
      }),
    revokeApproval: (approval) =>
      revokeApproval(approval, {
        approvalStateStore: context.approvalStateStore,
        approvalSecret: context.approvalSecret,
        approvalNow: context.approvalNow,
        toolboxRevision: context.toolboxRevision,
        policyRevision: context.policyRevision,
        approvalRevision: context.approvalRevision,
        getTool: context.getTool,
      }),
    issueGrant: (input: ReusableApprovalGrantInput): Promise<ReusableApprovalGrant> =>
      issueGrant(input, {
        approvalSecret: context.approvalSecret,
        grantStateStore: context.grantStateStore,
        approvalNonce: context.approvalNonce,
        approvalNow: context.approvalNow,
        policyRevision: context.policyRevision,
      }),
    revokeGrant: (id: string) => revokeGrant(id, context.grantStateStore),
    listGrants: (filter?: GrantListFilter) => listGrants(filter, context.grantStateStore),
  };
}

type NormalizedResolution = ToolApprovalResolution & {
  decision: ToolApprovalResolution['decision'];
};

type RejectionResolution = NormalizedResolution & { decision: 'deny' | 'cancel' };

function normalizeResolution(resolution: ToolApprovalResolution): NormalizedResolution {
  if (typeof resolution !== 'object' || resolution === null) {
    throw new Error('Approval resolution must be an object.');
  }
  const decision = resolution.decision;
  const remember = resolution.remember;
  const reason = resolution.reason;
  const hasEditedArgs = Object.prototype.hasOwnProperty.call(resolution, 'editedArgs');
  const editedArgs = decision === 'approve_with_edits' ? resolution.editedArgs : undefined;
  const snapshot = snapshotResolution({ decision, remember, reason, hasEditedArgs, editedArgs });
  if (!isResolutionDecision(snapshot.decision)) {
    throw new Error('Approval resolution decision is invalid.');
  }
  if (typeof snapshot.remember !== 'boolean') {
    throw new Error('Approval resolution remember must be boolean.');
  }
  if (snapshot.reason !== undefined && typeof snapshot.reason !== 'string') {
    throw new Error('Approval resolution reason must be a string.');
  }
  if (snapshot.decision === 'approve_with_edits' && !('editedArgs' in snapshot)) {
    throw new Error('Approval resolution editedArgs are required for approve_with_edits.');
  }
  return snapshot;
}

function snapshotResolution(resolution: {
  decision: ToolApprovalResolution['decision'];
  remember: ToolApprovalResolution['remember'];
  reason: ToolApprovalResolution['reason'];
  hasEditedArgs: boolean;
  editedArgs: unknown;
}): NormalizedResolution {
  const snapshot: NormalizedResolution = {
    decision: resolution.decision,
    remember: resolution.remember,
    ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
  };
  if (resolution.decision === 'approve_with_edits') {
    if (!resolution.hasEditedArgs) {
      throw new Error('Approval resolution editedArgs are required for approve_with_edits.');
    }
    const serialized = JSON.stringify(resolution.editedArgs);
    if (serialized === undefined) {
      throw new Error('Approval resolution editedArgs must be JSON-compatible.');
    }
    const editedArgs: unknown = JSON.parse(serialized);
    assertJsonValue(editedArgs, 'approvalResolution.editedArgs');
    snapshot.editedArgs = editedArgs;
  }
  return snapshot;
}

function snapshotResolveOptions(
  options: ToolboxResolveApprovalOptions,
): ToolboxResolveApprovalOptions {
  if (Object.prototype.hasOwnProperty.call(options, 'arguments')) {
    throw new Error('Approval resolution options cannot include arguments.');
  }
  return {
    ...options,
    requestContext: freezeToolRequestContext(options.requestContext),
  };
}

function isResolutionDecision(value: unknown): value is ToolApprovalResolution['decision'] {
  return (
    value === 'approve' || value === 'approve_with_edits' || value === 'deny' || value === 'cancel'
  );
}

function isRejectionResolution(
  resolution: NormalizedResolution,
): resolution is RejectionResolution {
  return resolution.decision === 'deny' || resolution.decision === 'cancel';
}

async function rejectApproval(
  approval: SignedPendingToolApproval,
  resolution: RejectionResolution,
  options: ToolboxResolveApprovalOptions,
  context: ToolboxApprovalContext,
): Promise<ToolExecutionResult> {
  if (!context.approvalStateStore || !approval.approvalBinding) {
    throw new Error('Approval state store and binding are required to resolve approval denial.');
  }
  const currentTool = context.getTool(approval.toolName);
  if (!currentTool) throw new Error(`Tool not found: ${approval.toolName}`);
  const approvalContext = createApprovalContext(options.requestContext, currentTool, context);
  const binding = approval.approvalBinding;
  await context.approvalStateStore.reserve(binding, approvalContext, context.approvalNow());
  try {
    await context.approvalStateStore.revoke(binding);
  } catch (error) {
    await context.approvalStateStore.release(binding);
    throw error;
  }
  return createRejectedApprovalResult(approval, resolution);
}

function createApprovalContext(
  requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>,
  currentTool: Tool,
  context: ToolboxApprovalContext,
): ApprovalBindingContext {
  const required = requireApprovalRequestContext(requestContext);
  return {
    principalId: required.authority.principalId,
    tenantId: required.authority.tenantId,
    ownerId: required.authority.ownerId,
    authorizationRevision: required.authority.authorizationRevision,
    capabilitiesRevision: JSON.stringify([...required.authority.capabilities].toSorted()),
    audience: required.audience,
    agentId: required.agentId,
    runId: required.runId,
    toolboxRevision: context.toolboxRevision,
    toolDefinitionRevision: currentTool.id,
    policyRevision: context.policyRevision,
    approvalRevision: context.approvalRevision,
  };
}

type RequiredApprovalRequestContext = Omit<ToolRequestContext, 'audience' | 'agentId' | 'runId'> & {
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
};

function requireApprovalRequestContext(
  requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>,
): RequiredApprovalRequestContext {
  if (!requestContext.agentId || !requestContext.runId || !requestContext.audience) {
    throw new Error('Request context and approval binding are required.');
  }
  return {
    ...requestContext,
    audience: requestContext.audience,
    agentId: requestContext.agentId,
    runId: requestContext.runId,
  };
}

function createRejectedApprovalResult(
  approval: SignedPendingToolApproval,
  resolution: RejectionResolution,
): ToolExecutionResult {
  const denied = resolution.decision === 'deny';
  const message = denied ? 'The user denied this request.' : 'The user cancelled this request.';
  const error: ToolError = {
    code: denied ? 'denied' : 'CANCELLED',
    category: denied ? 'permission' : 'cancelled',
    retryable: false,
    message,
    details: normalizeRejectionDetails(resolution),
  };
  return {
    callId: approval.callId,
    outcome: 'error',
    content: message,
    toolCallId: approval.callId,
    toolName: approval.toolName,
    result: undefined,
    error,
    errorMessage: error.message,
    errorCategory: error.category,
  };
}

function normalizeRejectionDetails(
  resolution: NormalizedResolution & { decision: 'deny' | 'cancel' },
): JSONValue {
  return {
    decision: resolution.decision,
    remember: resolution.remember,
    ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
  };
}
