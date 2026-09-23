import type { EffectiveToolExecutionContext } from './execution-context';
import type { ExecutionHandle, ExecutionLifecycle } from './execution-lifecycle';
import type { Tool } from './is-tool';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { ToolCall } from './types';

export type ChildExecutionContext = {
  readonly executionLifecycle: ExecutionLifecycle;
  readonly options: ToolboxExecuteOptions;
  readonly hasSingleChild: boolean;
  readonly nowFunction: () => number;
  readonly executionHandle: ExecutionHandle;
  readonly callIndex: number;
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  readonly initialEffectiveContext: EffectiveToolExecutionContext | undefined;
};

export type ChildExecution = {
  readonly cleanup: Array<() => void>;
  readonly childExecutionHandle: ExecutionHandle | undefined;
  readonly privilegedContextMirrorHandle: ExecutionHandle | undefined;
  readonly childExecutionId: string;
  readonly settleChildExecution: (result?: unknown) => void;
};

export function createChildExecution(context: ChildExecutionContext): ChildExecution {
  const {
    executionLifecycle,
    options,
    hasSingleChild,
    nowFunction,
    executionHandle,
    callIndex,
    tool,
    toolCall,
    initialEffectiveContext,
  } = context;
  const cleanup: Array<() => void> = [];
  const childExecutionHandle = createChildHandle({
    executionLifecycle,
    options,
    hasSingleChild,
    nowFunction,
    executionHandle,
    callIndex,
    tool,
    toolCall,
    initialEffectiveContext,
  });
  const privilegedContextMirrorHandle = hasSingleChild ? executionHandle : childExecutionHandle;
  const childExecutionId =
    childExecutionHandle?.id ?? `${executionHandle.id}:call:${callIndex + 1}`;
  const settleChildExecution = (result?: unknown) => {
    if (!childExecutionHandle) return;
    if (childExecutionHandle.snapshot().state === 'abort-requested') {
      childExecutionHandle.cleanupPending(result);
      childExecutionHandle.cleanup();
      return;
    }
    childExecutionHandle.settle(result);
  };
  childExecutionHandle?.activate();
  return {
    cleanup,
    childExecutionHandle,
    privilegedContextMirrorHandle,
    childExecutionId,
    settleChildExecution,
  };
}

function createChildHandle(context: ChildExecutionContext): ExecutionHandle | undefined {
  const {
    executionLifecycle,
    options,
    hasSingleChild,
    nowFunction,
    executionHandle,
    callIndex,
    tool,
    toolCall,
    initialEffectiveContext,
  } = context;
  if (hasSingleChild || !initialEffectiveContext) return undefined;
  return executionLifecycle.begin({
    executionId: `${executionHandle.id}:child:${callIndex + 1}`,
    toolName: tool.name,
    callId: toolCall.id,
    ownerId: executionHandle.snapshot().ownerId,
    parentExecutionId: executionHandle.id,
    ...(options.signal instanceof AbortSignal ? { signal: options.signal } : {}),
    ...(options.timeout !== undefined ? { deadline: nowFunction() + options.timeout } : {}),
    scheduleDeadline: false,
    now: nowFunction,
    privilegedContext: initialEffectiveContext,
  });
}
