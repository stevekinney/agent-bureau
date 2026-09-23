import type { RuntimeServices } from '@lostgradient/lifecycle';

import { freezeToolRequestContext } from '../execution-context';
import type { ExecutionHandle, ExecutionLifecycle } from '../execution-lifecycle';
import type { ToolCallWithArguments, ToolExecuteOptions, ToolExecuteWithOptions } from '../is-tool';
import {
  type ToolCallReturn,
  type ToolExecutionResult,
  type TypedToolExecutionResult,
  toolExecutionValue,
} from '../types';
import { normalizeToolContent } from './content';
import { createToolError, formatNonStringReason } from './errors';
import type { InternalToolExecuteOptions } from './execution-options';
import { isAbortSignalLike, resolveSuppliedOwnerId } from './execution-options';
import { createToolCall, looksLikeToolCall, normalizeToolCall } from './tool-call';

type RunWithConcurrency = <T>(
  task: () => Promise<T>,
  options?: { signal?: AbortSignal; onQueuePosition?: (position: number) => void },
) => Promise<T>;

export type ToolExecutors<TReturn> = {
  execute: {
    (input: ToolCallWithArguments, options?: ToolExecuteOptions): Promise<ToolExecutionResult>;
    (input: unknown, options?: ToolExecuteOptions): Promise<ToolCallReturn<TReturn>>;
  };
  executeCall: (
    toolCall: ToolCallWithArguments,
    options?: InternalToolExecuteOptions,
  ) => Promise<TypedToolExecutionResult<TReturn>>;
  executeParams: (
    params: unknown,
    options?: ToolExecuteOptions,
  ) => Promise<ToolCallReturn<TReturn>>;
  executeWith: (options: ToolExecuteWithOptions) => Promise<ToolExecutionResult>;
};

export function createToolExecutors<TReturn>(input: {
  name: string;
  timeout: number | undefined;
  runtime: RuntimeServices;
  executionLifecycle: ExecutionLifecycle;
  capacity: number | undefined;
  runWithConcurrency: RunWithConcurrency;
  executeInner: (
    toolCall: ToolCallWithArguments,
    options?: InternalToolExecuteOptions,
  ) => Promise<TypedToolExecutionResult<TReturn>>;
}): ToolExecutors<TReturn> {
  const executeCall = (
    toolCall: ToolCallWithArguments,
    options?: InternalToolExecuteOptions,
  ): Promise<TypedToolExecutionResult<TReturn>> =>
    runToolCall({
      ...input,
      toolCall,
      ...(options !== undefined ? { options } : {}),
    });
  const executeParams = async (
    params: unknown,
    options?: ToolExecuteOptions,
  ): Promise<ToolCallReturn<TReturn>> => {
    const toolCall = createToolCall(input.name, normalizeToolContent(params));
    const result = await executeCall(toolCall, options);
    const errorMessage = result.error?.message;
    if (errorMessage) throw new Error(errorMessage);
    const value = result[toolExecutionValue];
    if (!value) throw new Error('Tool execution completed without a return value.');
    return value.value;
  };
  function execute(
    inputValue: ToolCallWithArguments,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecutionResult>;
  function execute(
    inputValue: unknown,
    options?: ToolExecuteOptions,
  ): Promise<ToolCallReturn<TReturn>>;
  function execute(
    inputValue: unknown,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecutionResult> | Promise<ToolCallReturn<TReturn>> {
    if (looksLikeToolCall(inputValue, input.name)) {
      return executeCall(inputValue, options);
    }
    return executeParams(inputValue, options);
  }
  return {
    execute,
    executeCall,
    executeParams,
    executeWith(options: ToolExecuteWithOptions) {
      const toolCall = createToolCall(
        input.name,
        normalizeToolContent(options.params),
        options.callId,
      );
      const resolvedTimeout = options.timeout ?? input.timeout;
      return executeCall(toolCall, {
        ...options,
        ...(resolvedTimeout !== undefined ? { timeout: resolvedTimeout } : {}),
      });
    },
  };
}

type RunToolCallInput<TReturn> = {
  name: string;
  timeout: number | undefined;
  runtime: RuntimeServices;
  executionLifecycle: ExecutionLifecycle;
  capacity: number | undefined;
  runWithConcurrency: RunWithConcurrency;
  executeInner: (
    toolCall: ToolCallWithArguments,
    options?: InternalToolExecuteOptions,
  ) => Promise<TypedToolExecutionResult<TReturn>>;
  toolCall: ToolCallWithArguments;
  options?: InternalToolExecuteOptions;
};

type PreparedToolCall<TReturn> = RunToolCallInput<TReturn> & {
  deadline: number | undefined;
  executionOptions: InternalToolExecuteOptions | undefined;
  nowFunction: () => number;
  resolvedTimeout: number | undefined;
};

function runToolCall<TReturn>(
  input: RunToolCallInput<TReturn>,
): Promise<TypedToolExecutionResult<TReturn>> {
  const prepared = prepareToolCall(input);
  const executionHandle = beginExecutionLifecycle(prepared);
  if (hasExpiredDeadline(prepared)) {
    return settleExpiredDeadline(prepared, executionHandle);
  }
  const execution = runAdmittedToolCall(prepared, executionHandle);
  trackExecutionSettlement(execution, executionHandle);
  return execution;
}

function prepareToolCall<TReturn>(input: RunToolCallInput<TReturn>): PreparedToolCall<TReturn> {
  const executionOptions = freezeRequestContext(input.options);
  return {
    ...input,
    deadline: executionOptions?.requestContext?.deadline,
    executionOptions,
    nowFunction: executionOptions?.now ?? input.runtime.clock.now,
    resolvedTimeout: executionOptions?.timeout ?? input.timeout,
  };
}

function freezeRequestContext(
  options: InternalToolExecuteOptions | undefined,
): InternalToolExecuteOptions | undefined {
  if (!options?.requestContext) return options;
  return { ...options, requestContext: freezeToolRequestContext(options.requestContext) };
}

function hasExpiredDeadline<TReturn>(input: PreparedToolCall<TReturn>): boolean {
  return input.deadline !== undefined && input.deadline <= input.nowFunction();
}

function settleExpiredDeadline<TReturn>(
  input: PreparedToolCall<TReturn>,
  executionHandle: ExecutionHandle,
): Promise<TypedToolExecutionResult<TReturn>> {
  executionHandle.abort('deadline', 'Execution deadline exceeded');
  const result = deadlineCancellationResult(input.name, input.toolCall);
  executionHandle.settle(result);
  return Promise.resolve(result);
}

function runAdmittedToolCall<TReturn>(
  input: PreparedToolCall<TReturn>,
  executionHandle: ExecutionHandle,
): Promise<TypedToolExecutionResult<TReturn>> {
  return input
    .runWithConcurrency(() => executeNormalizedToolCall(input, executionHandle), {
      signal: executionHandle.signal,
      ...queuePositionOption(input.capacity, executionHandle),
    })
    .catch((error): TypedToolExecutionResult<TReturn> =>
      queuedCancellationResult(input.name, input.toolCall, error),
    );
}

function executeNormalizedToolCall<TReturn>(
  input: PreparedToolCall<TReturn>,
  executionHandle: ExecutionHandle,
): Promise<TypedToolExecutionResult<TReturn>> {
  executionHandle.activate();
  return input.executeInner(normalizeToolCall(input.toolCall, input.runtime), {
    ...input.executionOptions,
    ...(input.resolvedTimeout !== undefined ? { timeout: input.resolvedTimeout } : {}),
    signal: executionHandle.signal,
    executionHandle,
  });
}

function queuePositionOption(
  capacity: number | undefined,
  executionHandle: ExecutionHandle,
): { onQueuePosition?: (position: number) => void } {
  if (capacity === undefined) return {};
  return { onQueuePosition: (position) => executionHandle.queued(position, capacity) };
}

function trackExecutionSettlement(
  execution: Promise<ToolExecutionResult>,
  executionHandle: ExecutionHandle,
): void {
  void execution.then((result) => {
    if (shouldSettleExecution(result, executionHandle)) executionHandle.settle(result);
    return undefined;
  });
}

function shouldSettleExecution(
  result: ToolExecutionResult,
  executionHandle: ExecutionHandle,
): boolean {
  const state = executionHandle.snapshot().state;
  return !result.stream && state !== 'cleanup-pending' && state !== 'streaming';
}

function beginExecutionLifecycle<TReturn>(input: PreparedToolCall<TReturn>): ExecutionHandle {
  return input.executionLifecycle.begin(createExecutionBeginInput(input));
}

function createExecutionBeginInput(
  input: PreparedToolCall<unknown>,
): Parameters<ExecutionLifecycle['begin']>[0] {
  const executionInput: Parameters<ExecutionLifecycle['begin']>[0] = {
    toolName: input.name,
    callId: input.toolCall.id,
    scheduleDeadline: input.executionOptions?.requestContext?.deadline !== undefined,
    now: input.nowFunction,
  };
  applySuppliedExecutionOptions(executionInput, input);
  return executionInput;
}

function applySuppliedExecutionOptions(
  executionInput: Parameters<ExecutionLifecycle['begin']>[0],
  input: PreparedToolCall<unknown>,
): void {
  applyExecutionIdentityOptions(executionInput, input.executionOptions);
  applyExecutionSignalOptions(executionInput, input.executionOptions);
  applyExecutionDeadlineOptions(executionInput, input);
  applyExecutionTimerOptions(executionInput, input.executionOptions);
}

function applyExecutionIdentityOptions(
  executionInput: Parameters<ExecutionLifecycle['begin']>[0],
  options: InternalToolExecuteOptions | undefined,
): void {
  const ownerId = resolveSuppliedOwnerId(options ?? {});
  if (options?.executionId) executionInput.executionId = options.executionId;
  if (ownerId !== undefined) executionInput.ownerId = ownerId;
  if (options?.parentExecutionId) executionInput.parentExecutionId = options.parentExecutionId;
}

function applyExecutionSignalOptions(
  executionInput: Parameters<ExecutionLifecycle['begin']>[0],
  options: InternalToolExecuteOptions | undefined,
): void {
  if (isAbortSignalLike(options?.signal)) executionInput.signal = options.signal;
  if (options?.effectiveContext) executionInput.privilegedContext = options.effectiveContext;
}

function applyExecutionDeadlineOptions(
  executionInput: Parameters<ExecutionLifecycle['begin']>[0],
  input: PreparedToolCall<unknown>,
): void {
  if (input.deadline !== undefined) executionInput.deadline = input.deadline;
  if (input.capacity !== undefined) executionInput.capacity = input.capacity;
}

function applyExecutionTimerOptions(
  executionInput: Parameters<ExecutionLifecycle['begin']>[0],
  options: InternalToolExecuteOptions | undefined,
): void {
  if (options?.setTimeoutFunction) executionInput.setTimeoutFunction = options.setTimeoutFunction;
  if (options?.clearTimeoutFunction)
    executionInput.clearTimeoutFunction = options.clearTimeoutFunction;
}

function queuedCancellationResult(
  toolName: string,
  toolCall: ToolCallWithArguments,
  reason: unknown,
): ToolExecutionResult {
  const formattedReason = formatNonStringReason(reason);
  const message = reason instanceof Error ? reason.message : (formattedReason ?? 'Cancelled');
  const toolError = createToolError('cancelled', message, {
    code: 'CANCELLED',
    retryable: false,
  });
  return {
    callId: toolCall.id,
    outcome: 'error',
    content: message,
    toolCallId: toolCall.id,
    toolName,
    result: undefined,
    error: toolError,
    errorMessage: message,
    errorCategory: 'cancelled',
  };
}

function deadlineCancellationResult(
  toolName: string,
  toolCall: ToolCallWithArguments,
): ToolExecutionResult {
  const message = 'TIMEOUT';
  const toolError = createToolError('timeout', message, { code: 'TIMEOUT', retryable: false });
  return {
    callId: toolCall.id,
    outcome: 'error',
    content: message,
    toolCallId: toolCall.id,
    toolName,
    result: undefined,
    error: toolError,
    errorMessage: message,
    errorCategory: 'timeout',
  };
}
