import { stableStringifyJson } from '../core/serialization/json';
import {
  approvalResumeSymbol,
  policyPauseDecisionsSymbol,
  policyPauseTierSymbol,
} from '../internal/approval-resume';
import type { ToolPolicyDecision } from '../is-tool';
import type { ToolExecutionResult } from '../types';
import type {
  AdmitToolExecutionOptions,
  ParsedAdmissionState,
  PolicyAdmissionState,
} from './admission';
import { normalizeToolContent } from './content';
import type { InternalToolExecuteOptions } from './execution-options';
import {
  createToolAction,
  policyPauseMatchesSatisfiedPause,
  type ToolActionContext,
} from './policy';

export async function handlePolicyPause<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
): Promise<PolicyAdmissionState | { kind: 'result'; result: ToolExecutionResult }> {
  const actionContext = createToolActionContext(input, parsedState);
  const decision = resumedPauseDecision(
    input.options,
    policyState.decision,
    policyState.executedArgumentsEdited,
    actionContext,
  );
  if (!isPauseDecision(decision)) {
    return { ...policyState, ...(decision !== undefined ? { decision } : {}) };
  }
  const pause = createPauseState(parsedState.parsed, input.options, decision, actionContext);
  if (pause.resumedApprovalIsSatisfied) {
    return { ...policyState, decision, resumedApprovalIsSatisfied: true };
  }
  input.emit('policy-action-required', {
    ...parsedState.parsedDetail,
    params: parsedState.parsed,
    reason: pause.reason,
  });
  await input.runPolicyAfter(
    { ...policyState.policyContext, outcome: 'action_required', reason: pause.reason },
    input.options.signal,
    parsedState.parsedDetail,
  );
  input.finishTelemetry('paused', { reason: pause.reason });
  input.emit('settled', {
    ...parsedState.parsedDetail,
    status: 'paused',
    result: undefined,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  return { kind: 'result', result: actionRequiredResult(input, parsedState, policyState, pause) };
}

function isPauseDecision(
  decision: ToolPolicyDecision | undefined,
): decision is ToolPolicyDecision & { status: 'needs_approval' | 'needs_input' } {
  return decision?.status === 'needs_approval' || decision?.status === 'needs_input';
}

function resumedPauseDecision(
  options: InternalToolExecuteOptions,
  decision: ToolPolicyDecision | undefined,
  executedArgumentsEdited: boolean,
  actionContext: ToolActionContext,
): ToolPolicyDecision | undefined {
  const policyPauseDecisions = decision?.[policyPauseDecisionsSymbol];
  const approvalResume = options[approvalResumeSymbol];
  if (
    policyPauseDecisions === undefined ||
    approvalResume === undefined ||
    executedArgumentsEdited
  ) {
    return decision;
  }
  return (
    firstUnsatisfiedPause(policyPauseDecisions, approvalResume.satisfiedPauses, actionContext) ?? {
      allow: true,
      status: 'allow',
    }
  );
}

function firstUnsatisfiedPause(
  decisions: readonly ToolPolicyDecision[],
  satisfiedPauses: NonNullable<
    InternalToolExecuteOptions[typeof approvalResumeSymbol]
  >['satisfiedPauses'],
  actionContext: ToolActionContext,
): ToolPolicyDecision | undefined {
  return decisions.find(
    (pauseDecision) =>
      !satisfiedPauses.some((satisfiedPause) =>
        policyPauseMatchesSatisfiedPause(pauseDecision, satisfiedPause, actionContext),
      ),
  );
}

function createToolActionContext<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
): ToolActionContext {
  return {
    arguments: parsedState.parsed,
    callId: parsedState.typedToolCall.id,
    policyVersion: input.options.effectiveContext?.revisions.policy,
    toolDefinitionRevision: input.configuration.id,
    toolName: input.name,
  };
}

type PauseState = {
  type: 'approval' | 'input';
  reason: string;
  action: ReturnType<typeof createToolAction>;
  tier: NonNullable<ToolPolicyDecision[typeof policyPauseTierSymbol]>;
  resumedApprovalIsSatisfied: boolean;
};

function createPauseState(
  parsed: unknown,
  options: InternalToolExecuteOptions,
  decision: ToolPolicyDecision & { status: 'needs_approval' | 'needs_input' },
  actionContext: ToolActionContext,
): PauseState {
  const type = decision.status === 'needs_approval' ? 'approval' : 'input';
  const reason = decision.reason ?? `Tool execution requires ${type}`;
  const action = createToolAction(type, decision, reason, actionContext);
  const approvalResume = options[approvalResumeSymbol];
  const resumedApprovalIsSatisfied =
    approvalResume !== undefined &&
    pauseResumeMatches({
      approvalResume,
      action,
      decision,
      parsed,
      reason,
      type,
    });
  const tier = decision[policyPauseTierSymbol] ?? 'tool';
  return { type, reason, action, tier, resumedApprovalIsSatisfied };
}

type PauseResumeMatchInput = {
  approvalResume: NonNullable<InternalToolExecuteOptions[typeof approvalResumeSymbol]>;
  action: ReturnType<typeof createToolAction>;
  decision: ToolPolicyDecision;
  parsed: unknown;
  reason: string;
  type: 'approval' | 'input';
};

function pauseResumeMatches(input: PauseResumeMatchInput): boolean {
  const tier = input.decision[policyPauseTierSymbol] ?? 'tool';
  return (
    input.approvalResume.approvedPolicyPauseTier === tier &&
    input.approvalResume.approvedAction.type === input.type &&
    input.approvalResume.reason === input.reason &&
    approvalArgumentsDigest(input.approvalResume.proposedArguments) ===
      approvalArgumentsDigest(input.parsed) &&
    approvalArgumentsDigest(input.approvalResume.approvedAction) ===
      approvalArgumentsDigest(input.action)
  );
}

function approvalArgumentsDigest(value: unknown): string {
  return stableStringifyJson(normalizeToolContent(value));
}

function actionRequiredResult<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
  pause: PauseState,
): ToolExecutionResult {
  const callId = parsedState.typedToolCall.id;
  return {
    callId,
    outcome: 'action_required',
    content: pause.reason,
    toolCallId: callId,
    toolName: input.name,
    result: undefined,
    action: pause.action,
    pendingApproval: {
      callId,
      toolName: input.name,
      arguments: normalizeToolContent(parsedState.parsed),
      action: pause.action,
      reason: pause.reason,
      metadata: normalizeToolContent(input.configuration.metadata ?? {}),
      policyPauseTier: pause.tier,
      ...(input.options[approvalResumeSymbol] !== undefined && !policyState.executedArgumentsEdited
        ? { satisfiedPolicyPauses: input.options[approvalResumeSymbol].satisfiedPauses }
        : {}),
    },
    inputDigest: input.inputDigest,
  };
}
