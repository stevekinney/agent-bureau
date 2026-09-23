import { z } from 'zod';

import type { ToolError, ToolErrorCategory } from '../core/errors';
import { errorString, normalizeError } from '../errors';
import type { ToolRequestContext } from '../execution-context';
import type {
  ToolDiagnostics,
  ToolPolicyAfterContext,
  ToolPolicyContext,
  ToolPolicyContextProvider,
} from '../is-tool';
import type { ToolCall, ToolExecutionResult } from '../types';
import { createDeadlineError, isAbortRejection } from './cancellation';
import { computeDigest, normalizeToolContent } from './content';
import {
  classifyErrorCategory,
  createToolError,
  defaultErrorCode,
  extractErrorCode,
  isTimeoutError,
  serializeZodIssues,
} from './errors';
import type { Emit, ExecutionDetail, FinishTelemetry, RunPolicyAfter } from './execution-contracts';
import type { InternalToolExecuteOptions } from './execution-options';
import { createDiagnostics } from './result-diagnostics';
import { injectErrorPolicyContext } from './result-policy-context';

export type SuccessInput = {
  value: unknown;
  outputDigest?: string;
  digestOutput: boolean;
  digestAlgorithm: 'sha256';
  parsedDetail: ExecutionDetail<ToolCall & { arguments: unknown }>;
  policyContext: ToolPolicyContext;
  typedToolCall: ToolCall & { arguments: unknown };
  name: string;
  inputDigest?: string;
  executedArgumentsEdited: boolean;
  options: InternalToolExecuteOptions;
  emit: Emit;
  runPolicyAfter: RunPolicyAfter;
  hasPolicyAfterHook: boolean;
  finishTelemetry: FinishTelemetry;
};

export function finalizeSuccessfulExecution(
  input: SuccessInput,
): Promise<ToolExecutionResult> | ToolExecutionResult {
  const outputDigest = resolveOutputDigest(input);
  input.emit('execute-success', { ...input.parsedDetail, result: input.value });
  input.emit('settled', {
    ...input.parsedDetail,
    result: input.value,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  if (input.hasPolicyAfterHook) {
    return finalizeSuccessWithPolicyAfter(input, outputDigest);
  }
  input.finishTelemetry('success', successTelemetryDetails(input, outputDigest));
  return successResult(input, outputDigest);
}

async function finalizeSuccessWithPolicyAfter(
  input: SuccessInput,
  outputDigest: string | undefined,
): Promise<ToolExecutionResult> {
  await input.runPolicyAfter(
    successPolicyContext(input, outputDigest),
    input.options.signal,
    input.parsedDetail,
  );
  input.finishTelemetry('success', successTelemetryDetails(input, outputDigest));
  return successResult(input, outputDigest);
}

function resolveOutputDigest(input: SuccessInput): string | undefined {
  return (
    input.outputDigest ??
    (input.digestOutput ? computeDigest(input.value, input.digestAlgorithm) : undefined)
  );
}

function successPolicyContext(
  input: SuccessInput,
  outputDigest: string | undefined,
): ToolPolicyAfterContext {
  return {
    ...input.policyContext,
    outcome: 'success',
    result: input.value,
    ...(outputDigest !== undefined ? { outputDigest } : {}),
  };
}

function successTelemetryDetails(
  input: SuccessInput,
  outputDigest: string | undefined,
): Parameters<FinishTelemetry>[1] {
  return {
    result: input.value,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
    ...(outputDigest !== undefined ? { outputDigest } : {}),
  };
}

function successResult(input: SuccessInput, outputDigest: string | undefined): ToolExecutionResult {
  const callId = input.typedToolCall.id;
  return {
    callId,
    outcome: 'success',
    content: normalizeToolContent(input.value),
    toolCallId: callId,
    toolName: input.name,
    result: input.value,
    executedArgumentsEdited: input.executedArgumentsEdited,
    inputDigest: input.inputDigest,
    outputDigest,
  };
}

export type ErrorInput = {
  error: unknown;
  toolCall: ToolCall & { arguments: unknown };
  options: InternalToolExecuteOptions;
  baseDetail: ExecutionDetail<ToolCall & { arguments: unknown }>;
  schema: unknown;
  diagnostics?: ToolDiagnostics;
  name: string;
  inputDigest?: string;
  policyRequestContext?: ToolRequestContext;
  policyContextProvider?: ToolPolicyContextProvider;
  buildPolicyContext: (
    toolCall: ToolCall,
    params: unknown,
    inputDigest?: string,
  ) => ToolPolicyContext;
  attachRequestContextPolicyFacts: (
    context: ToolPolicyContext,
    requestContext: ToolRequestContext | undefined,
  ) => void;
  runPolicyAfter: RunPolicyAfter;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
  finishTelemetry: FinishTelemetry;
  emit: Emit;
};

export async function finalizeFailedExecution(input: ErrorInput): Promise<ToolExecutionResult> {
  prepareExecutionHandleForError(input.options, input.error);
  if (
    isCancellationError(input) &&
    input.options.executionHandle?.snapshot().abortSource !== 'deadline'
  ) {
    return input.handleCancellation(abortReason(input));
  }
  const reportedError = reportedExecutionError(input.error, input.options);
  // COR-1261: built before the emit rather than inside `errorResult`, so the
  // `settled` event and the returned result carry the same `ToolError` instead
  // of two values derived separately from the same inputs. `toolbox-execution-
  // task.ts` hoists for the same reason one layer up. `classifyErrorCategory`
  // is pure, so moving it above the emit changes nothing else.
  const errorCategory = classifyErrorCategory(reportedError);
  const toolError = buildToolError(input, errorCategory, reportedError);
  emitFailure(input, reportedError, toolError);
  const policyContextOutcome = await createErrorPolicyContext(input);
  if ('result' in policyContextOutcome) return policyContextOutcome.result;
  await runErrorPolicyAfter(input, policyContextOutcome.context, errorCategory, reportedError);
  input.finishTelemetry('error', errorTelemetryDetails(input, errorCategory, reportedError));
  return errorResult(input, toolError);
}

function prepareExecutionHandleForError(options: InternalToolExecuteOptions, error: unknown): void {
  // Only an unfinished callback can own later completion. Pre-execution
  // cancellation must let the outer invocation settle its handle.
  if (
    options.callbackPending &&
    options.executionHandle &&
    (isTimeoutError(error) || options.signal?.aborted)
  ) {
    options.executionHandle.cleanupPending(error);
  }
}

function isCancellationError(input: Pick<ErrorInput, 'error' | 'options'>): boolean {
  return (
    isAbortRejection(input.error) ||
    (hasAbortMessage(input.error) &&
      input.options.executionHandle?.snapshot().abortSource !== undefined)
  );
}

function hasAbortMessage(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'message') === 'Aborted';
}

function abortReason(input: Pick<ErrorInput, 'error' | 'options'>): unknown {
  return (
    (isAbortRejection(input.error) ? input.error.reason : undefined) ??
    input.options.executionHandle?.snapshot().abortReason ??
    input.options.signal?.reason ??
    input.error
  );
}

function reportedExecutionError(error: unknown, options: InternalToolExecuteOptions): unknown {
  const deadlineAbort =
    options.executionHandle?.snapshot().abortSource === 'deadline' &&
    (isAbortRejection(error) ||
      (hasAbortMessage(error) && options.executionHandle?.snapshot().abortSource !== undefined));
  if (!deadlineAbort) return error;
  return createDeadlineError(
    (isAbortRejection(error) ? error.reason : undefined) ??
      options.executionHandle?.snapshot().abortReason,
  );
}

function emitFailure(input: ErrorInput, reportedError: unknown, toolError: ToolError): void {
  if (reportedError instanceof z.ZodError) {
    emitValidationFailure(input, reportedError, toolError);
    return;
  }
  input.emit('execute-error', { ...input.baseDetail, error: reportedError });
  emitSettledFailure(input, toolError);
}

function emitValidationFailure(input: ErrorInput, error: z.ZodError, toolError: ToolError): void {
  const diagnostics = createDiagnostics(input, error);
  // `validate-error` keeps the `ZodError` itself: its issues and the derived
  // diagnostics are the point of the event, and a `ToolError` cannot carry them.
  input.emit('validate-error', {
    ...input.baseDetail,
    params: input.toolCall.arguments,
    error,
    ...diagnostics,
  });
  emitSettledFailure(input, toolError);
}

function emitSettledFailure(input: ErrorInput, error: unknown): void {
  input.emit('settled', {
    ...input.baseDetail,
    error,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
}

async function createErrorPolicyContext(
  input: ErrorInput,
): Promise<{ context: ToolPolicyContext } | { result: ToolExecutionResult }> {
  const context = input.buildPolicyContext(
    input.toolCall,
    input.toolCall.arguments,
    input.inputDigest,
  );
  input.attachRequestContextPolicyFacts(context, input.policyRequestContext);
  const injected = await injectErrorPolicyContext(input, context);
  if (injected) return injected;
  input.attachRequestContextPolicyFacts(context, input.policyRequestContext);
  return { context };
}

async function runErrorPolicyAfter(
  input: ErrorInput,
  context: ToolPolicyContext,
  errorCategory: ToolErrorCategory,
  reportedError: unknown,
): Promise<void> {
  try {
    await input.runPolicyAfter(
      { ...context, outcome: 'error', errorCategory, error: reportedError },
      input.options.signal,
      input.baseDetail,
    );
  } catch {
    // Preserve the original timeout/cancellation result when reporting fails.
  }
}

function errorTelemetryDetails(
  input: ErrorInput,
  errorCategory: ToolErrorCategory,
  reportedError: unknown,
): Parameters<FinishTelemetry>[1] {
  return {
    error: reportedError,
    errorCategory,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
  };
}

function buildToolError(
  input: ErrorInput,
  errorCategory: ToolErrorCategory,
  reportedError: unknown,
): ToolError {
  const normalizedError = normalizeError(
    reportedError,
    isTimeoutError(reportedError) ? { code: 'TIMEOUT' } : undefined,
  );
  const message =
    errorCategory === 'timeout' ? normalizedError.message : errorString(normalizedError);
  return reportedError instanceof z.ZodError
    ? createToolError('validation', message, {
        code: 'VALIDATION_ERROR',
        retryable: false,
        details: { issues: serializeZodIssues(reportedError.issues) },
      })
    : createToolError(errorCategory, message, {
        code: extractErrorCode(input.error) ?? defaultErrorCode(errorCategory),
        retryable: errorCategory === 'transient' || errorCategory === 'timeout',
      });
}

function errorResult(input: ErrorInput, toolError: ToolError): ToolExecutionResult {
  const callId = input.toolCall.id;
  const message = toolError.message;
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
}
