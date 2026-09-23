import { approvalConsumeSymbol, policyAuthorizationOnlySymbol } from '../internal/approval-resume';
import type { ToolExecutionResult } from '../types';
import type {
  AdmissionOutcome,
  AdmitToolExecutionOptions,
  ParsedAdmissionState,
  PolicyAdmissionState,
} from './admission';
import { createAbortRejection } from './cancellation';
import type { InternalToolExecuteOptions } from './execution-options';

export async function handleAuthorizationOnly<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
): Promise<AdmissionOutcome<TInput>> {
  if (!input.options[policyAuthorizationOnlySymbol]) {
    return readyAdmission(parsedState, policyState);
  }
  const rollbackApprovalAdmission = await consumeApproval(input.options);
  if (input.options.signal?.aborted) {
    return cancelAuthorization(input, rollbackApprovalAdmission);
  }
  input.emit('execute-success', { ...parsedState.parsedDetail, result: undefined });
  input.emit('settled', {
    ...parsedState.parsedDetail,
    result: undefined,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  try {
    await input.runPolicyAfter(
      { ...policyState.policyContext, outcome: 'success', result: undefined },
      input.options.signal,
      parsedState.parsedDetail,
    );
  } catch (error) {
    if (rollbackApprovalAdmission) await rollbackApprovalAdmission();
    throw error;
  }
  input.finishTelemetry('success');
  return { kind: 'result', result: authorizationOnlyResult(input, parsedState, policyState) };
}

function readyAdmission<TInput>(
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
): AdmissionOutcome<TInput> {
  return {
    kind: 'ready',
    parsed: parsedState.parsed,
    typedToolCall: parsedState.typedToolCall,
    parsedDetail: parsedState.parsedDetail,
    policyContext: policyState.policyContext,
    ...(policyState.effectiveRequestContext !== undefined
      ? { effectiveRequestContext: policyState.effectiveRequestContext }
      : {}),
    executedArgumentsEdited: policyState.executedArgumentsEdited,
  };
}

async function cancelAuthorization<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  rollback: (() => Promise<void>) | undefined,
): Promise<AdmissionOutcome<TInput>> {
  if (rollback) await rollback();
  if (input.options.executionHandle?.snapshot().abortSource === 'deadline') {
    throw createAbortRejection(input.options.signal?.reason);
  }
  return { kind: 'cancelled', result: input.handleCancellation(input.options.signal?.reason) };
}

async function consumeApproval(
  options: InternalToolExecuteOptions,
): Promise<(() => Promise<void>) | undefined> {
  return options[approvalConsumeSymbol]?.();
}

function authorizationOnlyResult<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
): ToolExecutionResult {
  const callId = parsedState.typedToolCall.id;
  return {
    callId,
    outcome: 'success',
    content: '',
    toolCallId: callId,
    toolName: input.name,
    result: undefined,
    executedArgumentsEdited: policyState.executedArgumentsEdited,
    inputDigest: input.inputDigest,
  };
}
