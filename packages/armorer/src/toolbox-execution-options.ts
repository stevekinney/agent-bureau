import type { EffectiveToolExecutionContext } from './execution-context';
import type { ExecutionHandle } from './execution-lifecycle';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
  type ApprovalAdmissionRollback,
} from './internal/approval-resume';
import type {
  InternalToolboxExecuteOptions,
  InternalToolExecuteOptionsWithMirror,
  ToolboxExecuteOptions,
} from './toolbox-contracts';

export type ExecuteOptionsInput = {
  readonly options:
    (InternalToolboxExecuteOptions & { [approvalConsumeSymbol]?: unknown }) | undefined;
  readonly suppliedOwnerId: string | undefined;
  readonly durableOperationKey: string | undefined;
  readonly resolvedTraceContext: unknown;
  readonly resolvedExecutionContext: Record<string, unknown> | undefined;
  readonly parentExecutionId: string;
  readonly privilegedContextMirrorHandle: ExecutionHandle | undefined;
  readonly requestContext: NonNullable<ToolboxExecuteOptions['requestContext']> | undefined;
  readonly initialEffectiveContext: EffectiveToolExecutionContext | undefined;
  readonly hasSingleChild: boolean;
  readonly executionHandle: ExecutionHandle;
  readonly onParentCompletionPending: (pending: boolean) => void;
};

export function createToolExecuteOptions(
  input: ExecuteOptionsInput,
): InternalToolExecuteOptionsWithMirror {
  if (!hasExecutionOptions(input) && !hasContextOptions(input) && !hasApprovalOptions(input)) {
    return {};
  }
  return {
    ...copyExecutionOptions(input),
    ...copyContextOptions(input),
    ...copyApprovalOptions(input),
  };
}

function hasExecutionOptions(input: ExecuteOptionsInput): boolean {
  return hasExecutionIdentity(input) || hasExecutionTiming(input) || hasOperationKey(input);
}

function hasExecutionIdentity(input: ExecuteOptionsInput): boolean {
  return input.suppliedOwnerId !== undefined;
}

function hasExecutionTiming(input: ExecuteOptionsInput): boolean {
  return hasAbortTiming(input) || hasCallbackTiming(input);
}

function hasAbortTiming(input: ExecuteOptionsInput): boolean {
  const options = input.options;
  return Boolean(
    options?.signal || options?.timeout !== undefined || options?.stream !== undefined,
  );
}

function hasCallbackTiming(input: ExecuteOptionsInput): boolean {
  const options = input.options;
  return Boolean(
    options?.elicit ||
    options?.now !== undefined ||
    options?.setTimeoutFunction !== undefined ||
    options?.clearTimeoutFunction !== undefined,
  );
}

function hasOperationKey(input: ExecuteOptionsInput): boolean {
  return input.durableOperationKey !== undefined;
}

function hasContextOptions(input: ExecuteOptionsInput): boolean {
  return Boolean(
    input.options?.requestContext ||
    input.resolvedTraceContext !== undefined ||
    input.resolvedExecutionContext !== undefined,
  );
}

function hasApprovalOptions(input: ExecuteOptionsInput): boolean {
  const options = input.options;
  return (
    options !== undefined &&
    (approvalResumeSymbol in options ||
      approvalConsumeSymbol in options ||
      policyAuthorizationOnlySymbol in options)
  );
}

function copyExecutionOptions(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  return {
    ...copyAbortTiming(input),
    ...copyCallbackTiming(input),
    ...copyExecutionIdentity(input),
  };
}

function copyExecutionIdentity(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  return {
    ...(input.durableOperationKey !== undefined
      ? { durableOperationKey: input.durableOperationKey }
      : {}),
    ...(input.suppliedOwnerId !== undefined ? { ownerId: input.suppliedOwnerId } : {}),
  };
}

function copyAbortTiming(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  const options = input.options;
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options?.stream !== undefined ? { stream: options.stream } : {}),
  };
}

function copyCallbackTiming(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  const options = input.options;
  return {
    ...(options?.elicit ? { elicit: options.elicit } : {}),
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.setTimeoutFunction ? { setTimeoutFunction: options.setTimeoutFunction } : {}),
    ...(options?.clearTimeoutFunction
      ? { clearTimeoutFunction: options.clearTimeoutFunction }
      : {}),
  };
}

function copyContextOptions(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  const {
    resolvedTraceContext,
    resolvedExecutionContext,
    parentExecutionId,
    privilegedContextMirrorHandle,
    requestContext,
    initialEffectiveContext,
    hasSingleChild,
    executionHandle,
    onParentCompletionPending,
  } = input;
  return {
    ...(resolvedTraceContext !== undefined ? { traceContext: resolvedTraceContext } : {}),
    ...(resolvedExecutionContext !== undefined
      ? { executionContext: resolvedExecutionContext }
      : {}),
    parentExecutionId,
    ...(privilegedContextMirrorHandle ? { privilegedContextMirrorHandle } : {}),
    ...(requestContext && initialEffectiveContext
      ? { requestContext, effectiveContext: initialEffectiveContext }
      : {}),
    ...(hasSingleChild
      ? { parentCompletionHandle: executionHandle, onParentCompletionPending }
      : {}),
  };
}

function copyApprovalOptions(
  input: ExecuteOptionsInput,
): Partial<InternalToolExecuteOptionsWithMirror> {
  const { options } = input;
  const consume = options ? readApprovalConsumer(options) : undefined;
  return {
    ...(options && approvalResumeSymbol in options
      ? { [approvalResumeSymbol]: Reflect.get(options, approvalResumeSymbol) }
      : {}),
    ...(consume ? { [approvalConsumeSymbol]: consume } : {}),
    ...(options && policyAuthorizationOnlySymbol in options
      ? { [policyAuthorizationOnlySymbol]: Reflect.get(options, policyAuthorizationOnlySymbol) }
      : {}),
  };
}

function readApprovalConsumer(
  options: InternalToolboxExecuteOptions & { [approvalConsumeSymbol]?: unknown },
): (() => Promise<ApprovalAdmissionRollback>) | undefined {
  const value: unknown = options[approvalConsumeSymbol];
  if (typeof value !== 'function') return undefined;
  return async () => {
    const rollbackValue: unknown = await Reflect.apply(value, undefined, []);
    if (typeof rollbackValue !== 'function') {
      throw new Error('Approval admission consumer did not return a rollback function.');
    }
    return async () => {
      await Reflect.apply(rollbackValue, undefined, []);
    };
  };
}
