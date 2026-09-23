import type { ExecutionHandle } from './execution-lifecycle';
import type { Tool } from './is-tool';
import { resolveResultStream, wrapAsyncIterable } from './toolbox-execution-helpers';
import type { ToolCall, ToolExecutionResult } from './types';

export type ExecutionSettlementContext = {
  readonly result: ToolExecutionResult;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly executionId: string;
  readonly ownerId: string | undefined;
  readonly executionHandle: ExecutionHandle;
  readonly childExecutionHandle: ExecutionHandle | undefined;
  readonly cleanup: readonly (() => void)[];
  readonly settleChildExecution: (result?: unknown) => void;
  readonly finalizeParentStream: () => void;
  readonly onLiveStream: () => void;
  readonly emit: (type: 'complete' | 'error', detail: Record<string, unknown>) => boolean;
  readonly failFast: boolean;
};

export function settleToolResult(context: ExecutionSettlementContext): void {
  const { result } = context;
  const stream = resolveResultStream(result);
  const hasLiveStream = stream !== undefined;
  if (stream) {
    context.onLiveStream();
    context.childExecutionHandle?.streaming();
    context.executionHandle.streaming();
    const wrapped = wrapAsyncIterable(
      stream,
      () => {
        runCleanup(context.cleanup);
        context.settleChildExecution(result);
        context.finalizeParentStream();
      },
      context.executionHandle,
    );
    if (result.stream === stream) result.stream = wrapped;
    if (result.result === stream) result.result = wrapped;
  }
  settleToolOutcome(context, hasLiveStream);
}

function settleToolOutcome(context: ExecutionSettlementContext, hasLiveStream: boolean): void {
  const { result } = context;
  if (result.error) {
    context.emit('error', {
      tool: context.tool,
      result,
      executionId: context.executionId,
      ...(context.ownerId !== undefined ? { ownerId: context.ownerId } : {}),
    });
    runCleanup(context.cleanup);
    if (!hasLiveStream) context.settleChildExecution(result);
    if (context.failFast) throw result.error;
    return;
  }
  context.emit('complete', {
    tool: context.tool,
    result,
    executionId: context.executionId,
    ...(context.ownerId !== undefined ? { ownerId: context.ownerId } : {}),
  });
  if (!hasLiveStream) {
    runCleanup(context.cleanup);
    context.settleChildExecution(result);
  }
}

function runCleanup(cleanup: readonly (() => void)[]): void {
  for (const release of cleanup) release();
}
