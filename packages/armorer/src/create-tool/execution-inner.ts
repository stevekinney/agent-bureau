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
import type { ToolCall, ToolExecutionResult } from '../types';
import {
  computeInputDigest,
  createBaseDetail,
  createCancellationHandler,
  emitStartedTelemetry,
  isPreExecutionCancellation,
} from './execution-inner-support';
import type { InternalToolExecuteOptions } from './execution-options';
import { resolveSuppliedOwnerId } from './execution-options';
import { runExecutionPipeline } from './execution-pipeline';

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
type ExecutionInnerContext<TInput, TOutput, E extends ToolEventsMap> = {
  name: string;
  configuration: ToolConfiguration;
  runtime: RuntimeServices;
  digestOptions: { input: boolean; output: boolean; algorithm: 'sha256' };
  typedSchema: z.ZodType<TInput>;
  schema: z.ZodType;
  fn:
    | ((params: TInput, context: ToolContext<E>) => Promise<TOutput>)
    | Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  resolveExecute: () => Promise<(params: TInput, context: ToolContext<E>) => Promise<TOutput>>;
  policyContextProvider?: ToolPolicyContextProvider;
  policyHooks?: ToolPolicyHooks;
  buildPolicyContext: BuildPolicyContext;
  resolvePolicyDecision: ResolvePolicyDecision;
  runPolicyAfter: RunPolicyAfter;
  emit: Emit;
  dispatch: (event: Event) => boolean;
  diagnostics?: ToolDiagnostics;
  telemetryEnabled: boolean;
};

export function createExecuteInner<TInput, TOutput, E extends ToolEventsMap>(
  context: ExecutionInnerContext<TInput, TOutput, E>,
): (
  toolCall: ToolCall & { arguments: unknown },
  options?: InternalToolExecuteOptions,
) => Promise<ToolExecutionResult> {
  const {
    name,
    configuration,
    runtime,
    digestOptions,
    typedSchema,
    schema,
    fn,
    resolveExecute,
    policyContextProvider,
    policyHooks,
    buildPolicyContext,
    resolvePolicyDecision,
    runPolicyAfter,
    emit,
    dispatch,
    diagnostics,
    telemetryEnabled,
  } = context;
  const executeInner = async (
    toolCall: ToolCall & { arguments: unknown },
    options: InternalToolExecuteOptions = {},
  ): Promise<ToolExecutionResult> => {
    // AB-290: executionId/ownerId ride along on every `execute-start`,
    // `settled`, and `progress` event this call emits, spread from here so
    // the emit call sites below don't each have to remember to attach them.
    const suppliedOwnerId = resolveSuppliedOwnerId(options);
    const baseDetail = createBaseDetail(toolCall, configuration, options, suppliedOwnerId);
    const nowFunction = options.now ?? runtime.clock.now;
    const startedAt = telemetryEnabled ? nowFunction() : 0;
    const inputDigest = computeInputDigest(toolCall.arguments, digestOptions);

    const finishTelemetry = (
      status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused',
      details: {
        result?: unknown;
        error?: unknown;
        reason?: string;
        errorCategory?: ToolErrorCategory;
        inputDigest?: string;
        outputDigest?: string;
      } = {},
    ) => {
      if (!telemetryEnabled) return;
      const finishedAt = nowFunction();
      emit('tool.finished', {
        ...baseDetail,
        status,
        durationMs: finishedAt - startedAt,
        startedAt,
        finishedAt,
        ...details,
      });
    };

    emitStartedTelemetry(
      telemetryEnabled,
      emit,
      baseDetail,
      toolCall.arguments,
      startedAt,
      inputDigest,
    );

    const handleCancellation = createCancellationHandler({
      toolCall,
      options,
      inputDigest,
      name,
      baseDetail,
      emit,
      finishTelemetry,
    });

    if (isPreExecutionCancellation(options)) {
      return handleCancellation(options.signal?.reason);
    }
    return runExecutionPipeline({
      toolCall,
      options,
      inputDigest,
      name,
      configuration,
      typedSchema,
      schema,
      runtime,
      nowFunction,
      baseDetail,
      dispatch,
      emit,
      fn,
      resolveExecute,
      ...(policyContextProvider !== undefined ? { policyContextProvider } : {}),
      ...(policyHooks !== undefined ? { policyHooks } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      buildPolicyContext,
      resolvePolicyDecision,
      runPolicyAfter,
      finishTelemetry,
      handleCancellation,
      digestOptions,
    });
  };
  return executeInner;
}
