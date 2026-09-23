import type { z } from 'zod';
import { stableStringifyJson } from '../core/serialization/json';
import {
  freezeEffectiveToolExecutionContext,
  narrowToolAuthority,
  type ToolRequestContext,
} from '../execution-context';
import { approvalResumeSymbol, policyAuthorizationOnlySymbol } from '../internal/approval-resume';
import {
  type MinimalAbortSignal,
  type ToolCallWithArguments,
  type ToolConfiguration,
  type ToolPolicyContext,
  type ToolPolicyContextProvider,
  type ToolPolicyDecision,
} from '../is-tool';
import type { ToolCall, ToolExecutionResult } from '../types';
import { handleAuthorizationOnly } from './admission-authorization';
import { handlePolicyPause } from './admission-pause';
import { createAbortRejection, racePreExecution } from './cancellation';
import { normalizeToolContent } from './content';
import { createToolError } from './errors';
import type { Emit, ExecutionDetail, FinishTelemetry, RunPolicyAfter } from './execution-contracts';
import type { InternalToolExecuteOptions } from './execution-options';

export type ReadyAdmission<TInput> = {
  kind: 'ready';
  parsed: TInput;
  typedToolCall: ToolCallWithArguments;
  parsedDetail: ExecutionDetail<ToolCallWithArguments>;
  policyContext: ToolPolicyContext;
  effectiveRequestContext?: ToolRequestContext;
  executedArgumentsEdited: boolean;
};

export type AdmissionOutcome<TInput> =
  | ReadyAdmission<TInput>
  | { kind: 'result'; result: ToolExecutionResult }
  | { kind: 'cancelled'; result: ToolExecutionResult };

export type AdmitToolExecutionOptions<TInput> = {
  schema: z.ZodType<TInput>;
  toolCall: ToolCall & { arguments: unknown };
  options: InternalToolExecuteOptions;
  configuration: ToolConfiguration;
  name: string;
  inputDigest?: string;
  baseDetail: ExecutionDetail<ToolCall & { arguments: unknown }>;
  policyContextProvider?: ToolPolicyContextProvider;
  hasPolicyDecisionHook: boolean;
  buildPolicyContext: (
    toolCall: ToolCall,
    params: unknown,
    inputDigest?: string,
  ) => ToolPolicyContext;
  attachRequestContextPolicyFacts: (
    context: ToolPolicyContext,
    requestContext: ToolRequestContext | undefined,
  ) => void;
  resolvePolicyDecision: (
    context: ToolPolicyContext,
    signal?: MinimalAbortSignal,
  ) => Promise<ToolPolicyDecision | undefined>;
  runPolicyAfter: RunPolicyAfter;
  finishTelemetry: FinishTelemetry;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
  emit: Emit;
};

export async function admitToolExecution<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
): Promise<AdmissionOutcome<TInput>> {
  const parsedState = await parseToolCall(input);
  if (parsedState.kind !== 'ready') return parsedState;

  const fastAdmission = noPolicyFastAdmission(input, parsedState);
  if (fastAdmission) return fastAdmission;

  const policyState = await preparePolicy(input, parsedState);
  if (policyState.kind !== 'ready') return policyState;

  const pauseState = await handlePolicyPause(input, parsedState, policyState);
  if (pauseState.kind !== 'ready') return pauseState;

  const deniedState = await handlePolicyDenied(input, parsedState, pauseState);
  if (deniedState.kind !== 'ready') return deniedState;

  return handleAuthorizationOnly(input, parsedState, deniedState);
}

export type ParsedAdmissionState<TInput> = {
  kind: 'ready';
  parsed: TInput;
  typedToolCall: ToolCallWithArguments;
  parsedDetail: ExecutionDetail<ToolCallWithArguments>;
};

function noPolicyFastAdmission<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
): ReadyAdmission<TInput> | undefined {
  if (
    input.policyContextProvider ||
    input.hasPolicyDecisionHook ||
    input.options[policyAuthorizationOnlySymbol]
  ) {
    return undefined;
  }
  const policyContext = input.buildPolicyContext(
    parsedState.typedToolCall,
    parsedState.parsed,
    input.inputDigest,
  );
  input.attachRequestContextPolicyFacts(policyContext, input.options.requestContext);
  updateExecutionContext(input.options, input.options.requestContext);
  return {
    kind: 'ready',
    parsed: parsedState.parsed,
    typedToolCall: parsedState.typedToolCall,
    parsedDetail: parsedState.parsedDetail,
    policyContext,
    ...(input.options.requestContext !== undefined
      ? { effectiveRequestContext: input.options.requestContext }
      : {}),
    executedArgumentsEdited: approvalArgumentsWereEdited(parsedState.parsed, input.options),
  };
}

export type PolicyAdmissionState = {
  kind: 'ready';
  policyContext: ToolPolicyContext;
  effectiveRequestContext?: ToolRequestContext;
  executedArgumentsEdited: boolean;
  decision?: ToolPolicyDecision;
  resumedApprovalIsSatisfied: boolean;
};

async function parseToolCall<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
): Promise<ParsedAdmissionState<TInput> | { kind: 'cancelled'; result: ToolExecutionResult }> {
  const { emit, options, schema, toolCall, configuration, baseDetail, handleCancellation } = input;
  if (options.signal?.aborted) {
    if (options.executionHandle?.snapshot().abortSource === 'deadline') {
      throw createAbortRejection(options.signal.reason);
    }
    return { kind: 'cancelled', result: handleCancellation(options.signal.reason) };
  }
  const parsed = await racePreExecution(
    () => schema.parseAsync(toolCall.arguments),
    options.signal,
  );
  const typedToolCall: ToolCallWithArguments = {
    ...toolCall,
    arguments: normalizeToolContent(parsed),
  };
  const parsedDetail: ExecutionDetail<ToolCallWithArguments> = {
    toolCall: typedToolCall,
    configuration,
    ...(baseDetail.executionId !== undefined ? { executionId: baseDetail.executionId } : {}),
    ...(baseDetail.ownerId !== undefined ? { ownerId: baseDetail.ownerId } : {}),
  };
  emit('validate-success', { ...parsedDetail, params: toolCall.arguments, parsed });
  return { kind: 'ready', parsed, typedToolCall, parsedDetail };
}

async function preparePolicy<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
): Promise<PolicyAdmissionState | { kind: 'cancelled'; result: ToolExecutionResult }> {
  const { options, policyContextProvider, inputDigest, handleCancellation } = input;
  if (options.signal?.aborted) {
    if (options.executionHandle?.snapshot().abortSource === 'deadline') {
      throw createAbortRejection(options.signal.reason);
    }
    return { kind: 'cancelled', result: handleCancellation(options.signal.reason) };
  }
  const policyContext = input.buildPolicyContext(
    parsedState.typedToolCall,
    parsedState.parsed,
    inputDigest,
  );
  input.attachRequestContextPolicyFacts(policyContext, options.requestContext);
  await injectPolicyContext(policyContext, policyContextProvider, options.signal);
  input.attachRequestContextPolicyFacts(policyContext, options.requestContext);
  const decision = await input.resolvePolicyDecision(policyContext, options.signal);
  const effectiveRequestContext = effectiveRequestContextFor(options.requestContext, decision);
  input.attachRequestContextPolicyFacts(policyContext, effectiveRequestContext);
  updateExecutionContext(options, effectiveRequestContext);
  const executedArgumentsEdited = approvalArgumentsWereEdited(parsedState.parsed, options);
  const resumedApprovalIsSatisfied = false;
  return {
    kind: 'ready',
    policyContext,
    ...(effectiveRequestContext !== undefined ? { effectiveRequestContext } : {}),
    executedArgumentsEdited,
    ...(decision !== undefined ? { decision } : {}),
    resumedApprovalIsSatisfied,
  };
}

async function injectPolicyContext(
  context: ToolPolicyContext,
  provider: ToolPolicyContextProvider | undefined,
  signal: MinimalAbortSignal | undefined,
): Promise<void> {
  if (!provider) return;
  const injected = await racePreExecution(() => provider(context), signal);
  if (injected && typeof injected === 'object' && !Array.isArray(injected)) {
    context.policyContext = injected;
  }
}

function effectiveRequestContextFor(
  requestContext: ToolRequestContext | undefined,
  decision: ToolPolicyDecision | undefined,
): ToolRequestContext | undefined {
  return requestContext && decision?.capabilities
    ? narrowToolAuthority(requestContext, decision.capabilities)
    : requestContext;
}

function updateExecutionContext(
  options: InternalToolExecuteOptions,
  effectiveRequestContext: ToolRequestContext | undefined,
): void {
  if (!effectiveRequestContext || !options.effectiveContext) return;
  const effectiveExecutionContext = freezeEffectiveToolExecutionContext({
    ...effectiveRequestContext,
    revisions: options.effectiveContext.revisions,
  });
  options.executionHandle?.updatePrivilegedContext(effectiveExecutionContext);
  options.privilegedContextMirrorHandle?.updatePrivilegedContext(effectiveExecutionContext);
}

function approvalArgumentsWereEdited(
  parsed: unknown,
  options: InternalToolExecuteOptions,
): boolean {
  const approvalResume = options[approvalResumeSymbol];
  if (approvalResume === undefined) return false;
  return (
    approvalArgumentsDigest(approvalResume.proposedArguments) !== approvalArgumentsDigest(parsed)
  );
}

function approvalArgumentsDigest(value: unknown): string {
  return stableStringifyJson(normalizeToolContent(value));
}

async function handlePolicyDenied<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  policyState: PolicyAdmissionState,
): Promise<PolicyAdmissionState | { kind: 'result'; result: ToolExecutionResult }> {
  if (policyState.decision?.allow !== false || policyState.resumedApprovalIsSatisfied) {
    return policyState;
  }
  const reason = policyState.decision.reason ?? 'Policy denied';
  const toolError = createToolError('permission', reason, {
    code: 'POLICY_DENIED',
    retryable: false,
  });
  const errorObj = new Error(reason);
  input.emit('policy-denied', { ...parsedState.parsedDetail, params: parsedState.parsed, reason });
  input.emit('execute-error', { ...parsedState.parsedDetail, error: errorObj });
  input.emit('settled', {
    ...parsedState.parsedDetail,
    // The same `ToolError` `deniedResult` returns below, not the `Error`
    // synthesized for `execute-error`. `settled` is terminal and is what a
    // consumer compares against the result; the two disagreeing in type is
    // COR-1261.
    error: toolError,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  await input.runPolicyAfter(
    { ...policyState.policyContext, outcome: 'denied', errorCategory: toolError.category, reason },
    input.options.signal,
    parsedState.parsedDetail,
  );
  input.finishTelemetry('denied', {
    reason,
    errorCategory: toolError.category,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
  });
  return { kind: 'result', result: deniedResult(input, parsedState, reason, toolError) };
}

function deniedResult<TInput>(
  input: AdmitToolExecutionOptions<TInput>,
  parsedState: ParsedAdmissionState<TInput>,
  reason: string,
  toolError: ReturnType<typeof createToolError>,
): ToolExecutionResult {
  const callId = parsedState.typedToolCall.id;
  return {
    callId,
    outcome: 'error',
    content: reason,
    toolCallId: callId,
    toolName: input.name,
    result: undefined,
    error: toolError,
    errorMessage: toolError.message,
    errorCategory: toolError.category,
    inputDigest: input.inputDigest,
  };
}
