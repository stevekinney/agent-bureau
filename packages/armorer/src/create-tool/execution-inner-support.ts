import type { ToolErrorCategory } from '../core/errors';
import type { ToolExecutionIdentity } from '../event-types';
import type { ToolRequestContext } from '../execution-context';
import type {
  ToolConfiguration,
  ToolDiagnostics,
  ToolPolicyAfterContext,
  ToolPolicyContext,
  ToolPolicyContextProvider,
} from '../is-tool';
import type { ToolCall, ToolExecutionResult } from '../types';
import { computeDigest } from './content';
import { createToolError, formatNonStringReason } from './errors';
import type { InternalToolExecuteOptions } from './execution-options';
import { attachRequestContextPolicyFacts } from './policy-hooks';
import { finalizeFailedExecution } from './result-handlers';

type ExecutionFailureInput = {
  toolCall: ToolCall & { arguments: unknown };
  options: InternalToolExecuteOptions;
  baseDetail: {
    toolCall: ToolCall & { arguments: unknown };
    configuration: ToolConfiguration;
  } & ToolExecutionIdentity;
  schema: import('zod').ZodType;
  diagnostics?: ToolDiagnostics;
  name: string;
  inputDigest: string | undefined;
  policyContextProvider?: ToolPolicyContextProvider;
  buildPolicyContext: (
    toolCall: ToolCall,
    params: unknown,
    inputDigest?: string,
  ) => ToolPolicyContext;
  runPolicyAfter: (
    context: ToolPolicyAfterContext,
    signal?: AbortSignal,
    identity?: ToolExecutionIdentity,
  ) => Promise<void>;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
  finishTelemetry: FinishTelemetry;
  emit: (type: string, detail: unknown) => boolean;
};

export async function finalizeExecutionFailure(
  input: ExecutionFailureInput,
  error: unknown,
  policyRequestContext: ToolRequestContext | undefined,
): Promise<ToolExecutionResult> {
  return finalizeFailedExecution({
    error,
    toolCall: input.toolCall,
    options: input.options,
    baseDetail: input.baseDetail,
    schema: input.schema,
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    name: input.name,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
    ...(policyRequestContext !== undefined ? { policyRequestContext } : {}),
    ...(input.policyContextProvider !== undefined
      ? { policyContextProvider: input.policyContextProvider }
      : {}),
    buildPolicyContext: input.buildPolicyContext,
    attachRequestContextPolicyFacts,
    runPolicyAfter: input.runPolicyAfter,
    handleCancellation: input.handleCancellation,
    finishTelemetry: input.finishTelemetry,
    emit: input.emit,
  });
}

export function isPreExecutionCancellation(options: InternalToolExecuteOptions): boolean {
  return (
    options.signal?.aborted === true &&
    options.executionHandle?.snapshot().abortSource !== 'deadline'
  );
}

export type FinishTelemetry = (
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

export type CancellationInput = {
  toolCall: ToolCall & { arguments: unknown };
  options: InternalToolExecuteOptions;
  inputDigest: string | undefined;
  name: string;
  baseDetail: {
    toolCall: ToolCall & { arguments: unknown };
    configuration: ToolConfiguration;
  } & ToolExecutionIdentity;
  emit: (type: string, detail: unknown) => boolean;
  finishTelemetry: FinishTelemetry;
};

export function createBaseDetail(
  toolCall: ToolCall & { arguments: unknown },
  configuration: ToolConfiguration,
  options: InternalToolExecuteOptions,
  ownerId: string | undefined,
): {
  toolCall: ToolCall & { arguments: unknown };
  configuration: ToolConfiguration;
} & ToolExecutionIdentity {
  return {
    toolCall,
    configuration,
    ...(options.executionHandle?.id !== undefined
      ? { executionId: options.executionHandle.id }
      : {}),
    ...(ownerId !== undefined ? { ownerId } : {}),
  };
}

export function computeInputDigest(
  argumentsValue: unknown,
  digestOptions: { input: boolean; algorithm: 'sha256' },
): string | undefined {
  return digestOptions.input ? computeDigest(argumentsValue, digestOptions.algorithm) : undefined;
}

export function emitStartedTelemetry(
  enabled: boolean,
  emit: (type: string, detail: unknown) => boolean,
  baseDetail: {
    toolCall: ToolCall & { arguments: unknown };
    configuration: ToolConfiguration;
  } & ToolExecutionIdentity,
  params: unknown,
  startedAt: number,
  inputDigest: string | undefined,
): void {
  if (!enabled) return;
  emit('tool.started', { ...baseDetail, params, startedAt, inputDigest });
}

export function createCancellationHandler(
  input: CancellationInput,
): (reason?: unknown) => ToolExecutionResult {
  return (reason) => {
    const message = cancellationMessage(reason);
    const errorObj = new Error(message);
    const toolError = createToolError('cancelled', message, {
      code: 'CANCELLED',
      retryable: false,
    });
    input.emit('execute-error', { ...input.baseDetail, error: errorObj });
    input.emit('settled', {
      ...input.baseDetail,
      // The same `ToolError` this handler returns below, not the `Error`
      // synthesized for `execute-error` (COR-1261).
      error: toolError,
      callbackCompletion: input.options.executionHandle?.whenSettled(),
    });
    input.finishTelemetry('cancelled', {
      error: errorObj,
      errorCategory: toolError.category,
      ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
    });
    const callId = input.toolCall.id;
    return {
      callId,
      outcome: 'error',
      content: message,
      toolCallId: callId,
      toolName: input.name,
      result: undefined,
      error: toolError,
      errorMessage: toolError.message,
      errorCategory: toolError.category,
      inputDigest: input.inputDigest,
    };
  };
}

function cancellationMessage(reason: unknown): string {
  if (typeof reason === 'string') return reason || 'Cancelled';
  if (reason instanceof Error) return reason.message || 'Cancelled';
  const formatted = formatNonStringReason(reason);
  return formatted ? `Cancelled: ${formatted}` : 'Cancelled';
}
