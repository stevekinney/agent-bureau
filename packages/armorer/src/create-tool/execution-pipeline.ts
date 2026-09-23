import { z } from 'zod';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ToolErrorCategory } from '../core/errors';
import type { ToolExecutionIdentity } from '../event-types';
import type {
  MinimalAbortSignal,
  ToolConfiguration,
  ToolContext,
  ToolDiagnostics,
  ToolEventsMap,
  ToolPolicyAfterContext,
  ToolPolicyContext,
  ToolPolicyContextProvider,
  ToolPolicyDecision,
  ToolPolicyHooks,
} from '../is-tool';
import {
  type ToolCall,
  type ToolExecutionResult,
  type TypedToolExecutionResult,
  toolExecutionValue,
} from '../types';
import { admitToolExecution } from './admission';
import { createAbortRejection, raceWithSignal } from './cancellation';
import { finalizeExecutionFailure } from './execution-inner-support';
import type { InternalToolExecuteOptions } from './execution-options';
import { attachRequestContextPolicyFacts } from './policy-hooks';
import { finalizeSuccessfulExecution } from './result-handlers';
import { runRuntimeExecution } from './runtime-execution';
import { handleStreamingExecution } from './streaming';

type Emit = (type: string, detail: unknown) => boolean;
type BuildPolicyContext = (
  toolCall: ToolCall,
  params: unknown,
  inputDigest?: string,
) => ToolPolicyContext;
type ResolvePolicyDecision = (
  context: ToolPolicyContext,
  signal?: MinimalAbortSignal,
) => Promise<ToolPolicyDecision | undefined>;
type RunPolicyAfter = (
  context: ToolPolicyAfterContext,
  signal?: MinimalAbortSignal,
  identity?: ToolExecutionIdentity,
) => Promise<void>;
type FinishTelemetry = (
  status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused',
  details?: {
    result?: unknown;
    error?: unknown;
    reason?: string;
    errorCategory?: ToolErrorCategory;
    inputDigest?: string;
    outputDigest?: string;
  },
) => void;

type ExecutionPipelineInput<TInput, TOutput, E extends ToolEventsMap> = {
  toolCall: ToolCall & { arguments: unknown };
  options: InternalToolExecuteOptions;
  inputDigest: string | undefined;
  name: string;
  configuration: ToolConfiguration;
  typedSchema: z.ZodType<TInput>;
  schema: z.ZodType;
  runtime: RuntimeServices;
  nowFunction: () => number;
  baseDetail: {
    toolCall: ToolCall & { arguments: unknown };
    configuration: ToolConfiguration;
  } & ToolExecutionIdentity;
  dispatch: (event: Event) => boolean;
  emit: Emit;
  fn:
    | ((params: TInput, context: ToolContext<E>) => Promise<TOutput>)
    | Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  resolveExecute: () => Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  policyContextProvider?: ToolPolicyContextProvider;
  policyHooks?: ToolPolicyHooks;
  diagnostics?: ToolDiagnostics;
  buildPolicyContext: BuildPolicyContext;
  resolvePolicyDecision: ResolvePolicyDecision;
  runPolicyAfter: RunPolicyAfter;
  finishTelemetry: FinishTelemetry;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
  digestOptions: { input: boolean; output: boolean; algorithm: 'sha256' };
};

export async function runExecutionPipeline<TInput, TOutput, E extends ToolEventsMap>(
  input: ExecutionPipelineInput<TInput, TOutput, E>,
): Promise<TypedToolExecutionResult<TOutput>> {
  const {
    toolCall,
    options,
    inputDigest,
    name,
    configuration,
    typedSchema,
    runtime,
    nowFunction,
    baseDetail,
    dispatch,
    emit,
    fn,
    resolveExecute,
    policyContextProvider,
    policyHooks,
    buildPolicyContext,
    resolvePolicyDecision,
    runPolicyAfter,
    finishTelemetry,
    handleCancellation,
    digestOptions,
  } = input;
  let policyRequestContext = options.requestContext;
  try {
    emit('execute-start', { ...baseDetail, params: toolCall.arguments });
    const admission = await admitToolExecution({
      schema: typedSchema,
      toolCall,
      options,
      configuration,
      name,
      ...(inputDigest !== undefined ? { inputDigest } : {}),
      baseDetail,
      ...(policyContextProvider !== undefined ? { policyContextProvider } : {}),
      hasPolicyDecisionHook: policyHooks?.beforeExecute !== undefined,
      buildPolicyContext,
      attachRequestContextPolicyFacts,
      resolvePolicyDecision,
      runPolicyAfter,
      finishTelemetry,
      handleCancellation,
      emit,
    });
    if (admission.kind !== 'ready') {
      if (admission.kind === 'result' && admission.result.outcome === 'success') {
        return {
          ...admission.result,
          [toolExecutionValue]: { kind: 'authorization-only', value: undefined },
        };
      }
      return admission.result;
    }
    policyRequestContext = admission.effectiveRequestContext;
    return await runReadyExecution({
      admission,
      options,
      inputDigest,
      nowFunction,
      baseDetail,
      configuration,
      runtime,
      name,
      dispatch,
      emit,
      fn,
      resolveExecute,
      digestOptions,
      runPolicyAfter,
      finishTelemetry,
      handleCancellation,
      hasPolicyAfterHook: policyHooks?.afterExecute !== undefined,
    });
  } catch (error) {
    return finalizeExecutionFailure(input, error, policyRequestContext);
  }
}

type ReadyExecutionInput<TInput, TOutput, E extends ToolEventsMap> = {
  admission: import('./admission').ReadyAdmission<TInput>;
  options: InternalToolExecuteOptions;
  inputDigest: string | undefined;
  nowFunction: () => number;
  baseDetail: {
    toolCall: ToolCall & { arguments: unknown };
    configuration: ToolConfiguration;
  } & ToolExecutionIdentity;
  configuration: ToolConfiguration;
  runtime: RuntimeServices;
  name: string;
  dispatch: (event: Event) => boolean;
  emit: Emit;
  fn:
    | ((params: TInput, context: ToolContext<E>) => Promise<TOutput>)
    | Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  resolveExecute: () => Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  digestOptions: { input: boolean; output: boolean; algorithm: 'sha256' };
  runPolicyAfter: RunPolicyAfter;
  finishTelemetry: FinishTelemetry;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
  hasPolicyAfterHook: boolean;
};

async function runReadyExecution<TInput, TOutput, E extends ToolEventsMap>(
  input: ReadyExecutionInput<TInput, TOutput, E>,
): Promise<TypedToolExecutionResult<TOutput>> {
  const {
    admission,
    options,
    inputDigest,
    nowFunction,
    baseDetail,
    configuration,
    runtime,
    name,
    dispatch,
    emit,
    fn,
    resolveExecute,
    digestOptions,
    runPolicyAfter,
    finishTelemetry,
    handleCancellation,
    hasPolicyAfterHook,
  } = input;
  const resolvedExecute =
    typeof fn === 'function' ? fn : await raceWithSignal(resolveExecute(), options.signal);
  const runtimeOutcome = runRuntimeExecution<TInput, E, TOutput>({
    parsed: admission.parsed,
    typedToolCall: admission.typedToolCall,
    configuration,
    options,
    ...(admission.effectiveRequestContext !== undefined
      ? { effectiveRequestContext: admission.effectiveRequestContext }
      : {}),
    baseDetail,
    runtime,
    name,
    dispatch,
    runUserCallback: (params: TInput, toolContext: ToolContext<E>) =>
      Promise.resolve(resolvedExecute(params, toolContext)),
    handleCancellation,
  });
  if (runtimeOutcome.kind === 'cancelled') return runtimeOutcome.result;
  const streamingOutcome = await handleStreamingExecution({
    value: await Promise.resolve(runtimeOutcome.value),
    options,
    now: nowFunction,
    digestOptions,
    baseDetail,
    parsedDetail: admission.parsedDetail,
    policyContext: admission.policyContext,
    typedToolCall: admission.typedToolCall,
    name,
    inputDigest,
    executedArgumentsEdited: admission.executedArgumentsEdited,
    emit,
    runPolicyAfter,
    finishTelemetry,
    createAbortRejection,
  });
  if (streamingOutcome.kind === 'result') return streamingOutcome.result;
  const success = finalizeSuccessfulExecution({
    value: streamingOutcome.value,
    ...(streamingOutcome.outputDigest !== undefined
      ? { outputDigest: streamingOutcome.outputDigest }
      : {}),
    digestOutput: digestOptions.output,
    digestAlgorithm: digestOptions.algorithm,
    parsedDetail: admission.parsedDetail,
    policyContext: admission.policyContext,
    typedToolCall: admission.typedToolCall,
    name,
    ...(inputDigest !== undefined ? { inputDigest } : {}),
    executedArgumentsEdited: admission.executedArgumentsEdited,
    options,
    emit,
    runPolicyAfter,
    hasPolicyAfterHook,
    finishTelemetry,
  });
  const resolvedSuccess = success instanceof Promise ? await success : success;
  return {
    ...resolvedSuccess,
    [toolExecutionValue]: streamingOutcome.executionValue,
  };
}
