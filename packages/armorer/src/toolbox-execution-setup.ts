import { freezeToolRequestContext, type EffectiveToolExecutionContext } from './execution-context';
import type { ExecutionHandle, ExecutionLifecycle } from './execution-lifecycle';
import type { InternalToolboxExecuteOptions } from './toolbox-contracts';
import type { ToolCallInput } from './types';

export type ExecutionPreparationContext = {
  readonly executionLifecycle: ExecutionLifecycle;
  readonly createEffectiveExecutionContext: (
    requestContext: NonNullable<InternalToolboxExecuteOptions['requestContext']>,
    revision: string,
  ) => EffectiveToolExecutionContext;
  readonly toolDefinitionRevisionForCall: (call: ToolCallInput | undefined) => string;
};

export function prepareExecution(
  context: ExecutionPreparationContext,
  input: ToolCallInput | ToolCallInput[],
  options: InternalToolboxExecuteOptions | undefined,
): {
  options: InternalToolboxExecuteOptions;
  nowFunction: () => number;
  deadline: number | undefined;
  suppliedOwnerId: string | undefined;
  executionHandle: ReturnType<ExecutionLifecycle['begin']>;
} {
  const requestContext = options?.requestContext
    ? freezeToolRequestContext(options.requestContext)
    : undefined;
  const normalizedOptions = requestContext ? { ...options, requestContext } : (options ?? {});
  const firstCall = Array.isArray(input) ? input[0] : input;
  const nowFunction = normalizedOptions.now ?? Date.now;
  const deadline = normalizedOptions.requestContext?.deadline;
  const suppliedOwnerId = normalizedOptions.ownerId ?? requestContext?.authority.ownerId;
  const executionHandle = context.executionLifecycle.begin(
    createExecutionParameters(
      context,
      input,
      normalizedOptions,
      firstCall,
      nowFunction,
      deadline,
      suppliedOwnerId,
    ),
  );
  return { options: normalizedOptions, nowFunction, deadline, suppliedOwnerId, executionHandle };
}

function createExecutionParameters(
  context: ExecutionPreparationContext,
  input: ToolCallInput | ToolCallInput[],
  options: InternalToolboxExecuteOptions,
  firstCall: ToolCallInput | undefined,
  nowFunction: () => number,
  deadline: number | undefined,
  suppliedOwnerId: string | undefined,
) {
  return {
    ...executionIdentityParameters(input, options, firstCall, nowFunction, suppliedOwnerId),
    ...executionTimingParameters(options, nowFunction, deadline),
    ...(options.requestContext
      ? {
          privilegedContext: context.createEffectiveExecutionContext(
            options.requestContext,
            Array.isArray(input) ? 'batch' : context.toolDefinitionRevisionForCall(firstCall),
          ),
        }
      : {}),
  };
}

export function executionIdentityParameters(
  input: ToolCallInput | ToolCallInput[],
  options: InternalToolboxExecuteOptions,
  firstCall: ToolCallInput | undefined,
  nowFunction: () => number,
  suppliedOwnerId: string | undefined,
) {
  return {
    ...(options.executionId ? { executionId: options.executionId } : {}),
    toolName: Array.isArray(input) ? 'toolbox.batch' : (firstCall?.name ?? 'toolbox.unknown'),
    callId: firstCall?.id ?? `toolbox-call-${nowFunction()}`,
    ...(suppliedOwnerId !== undefined ? { ownerId: suppliedOwnerId } : {}),
    ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
  };
}

export function executionTimingParameters(
  options: InternalToolboxExecuteOptions,
  nowFunction: () => number,
  deadline: number | undefined,
) {
  return {
    ...(options.signal instanceof AbortSignal ? { signal: options.signal } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    now: nowFunction,
    ...(options.setTimeoutFunction ? { setTimeoutFunction: options.setTimeoutFunction } : {}),
    ...(options.clearTimeoutFunction ? { clearTimeoutFunction: options.clearTimeoutFunction } : {}),
  };
}

export function isAbortRequested(handle: ExecutionHandle): boolean {
  const state = handle.snapshot().state;
  return state === 'abort-requested' || state === 'cleanup-pending';
}
