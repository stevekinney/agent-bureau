import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ApprovalStateStore } from './approval-binding';
import {
  type ToolboxBudgetExceededToolError,
  type ToolError,
  type ToolErrorCategory,
} from './core/errors';
import type { LoopDetector } from './core/loop-detection';
import { type EffectiveToolExecutionContext } from './execution-context';
import type { ExecutionLifecycle } from './execution-lifecycle';
import type { Tool, ToolConfiguration } from './is-tool';
import type {
  InternalToolboxExecuteOptions,
  ToolboxEntries,
  ToolboxEvents,
  ToolboxEventType,
  ToolboxExecuteOptions,
  ToolboxOptions,
} from './toolbox-contracts';
import { prepareExecution } from './toolbox-execution-setup';
import { createExecutionTask } from './toolbox-execution-task';
import type {
  ToolboxCallInputForTools,
  ToolboxResultForCall,
  ToolsFromEntries,
} from './toolbox-type-inference';
import type { SignedPendingToolApproval, ToolCallInput, ToolExecutionResult } from './types';
import { createConcurrencyLimiter } from './utilities/concurrency';
export type ExecutorContext = {
  runtime: RuntimeServices;
  executionLifecycle: ExecutionLifecycle;
  toolsByName: Map<string, Tool[]>;
  getTool: (name: string) => Tool | undefined;
  resolutionEnabled: boolean;
  emit: {
    <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]): boolean;
    (type: string, detail: unknown): boolean;
  };
  storedConfigurations: Map<string, ToolConfiguration>;
  onDeprecatedToolCalled: ToolboxOptions['onDeprecatedToolCalled'];
  loopDetectors: Map<string, LoopDetector>;
  autoLoopDetector: LoopDetector | undefined;
  budget: ToolboxOptions['budget'];
  budgetStart: number;
  budgetCalls: { value: number };
  baseContext: Record<string, unknown>;
  createEffectiveExecutionContext: (
    requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>,
    revision: string,
  ) => EffectiveToolExecutionContext;
  toolDefinitionRevisionForCall: (call: ToolCallInput | undefined) => string;
  createToolError: (
    category: ToolError['category'],
    message: string,
    code: string,
    retryable: boolean,
  ) => ToolError;
  createToolboxBudgetExceededToolError: (message: string) => ToolboxBudgetExceededToolError;
  extractErrorCode: (error: unknown) => string | undefined;
  isToolAvailable: (tool: Tool, signal?: AbortSignal) => Promise<boolean | 'timeout' | 'cancelled'>;
  approvalSecret: string | undefined;
  approvalStateStore: ApprovalStateStore | undefined;
  approvalNow: () => number;
  approvalBindingTtlMs: number;
  approvalNonce: () => string;
  toolboxRevision: string;
  policyRevision: string;
  approvalRevision: string;
  createInterruptedResumeApprovalValidationResult: (
    approval: SignedPendingToolApproval,
    category: ToolErrorCategory,
    message: string,
    code: string,
  ) => ToolExecutionResult;
};
type BatchExecutionState = { pendingChildCallbacks: number };

export function createExecutor<TEntries extends ToolboxEntries>(context: ExecutorContext) {
  const {
    runtime,
    executionLifecycle,
    toolsByName,
    getTool,
    resolutionEnabled,
    emit,
    storedConfigurations,
    onDeprecatedToolCalled,
    loopDetectors,
    autoLoopDetector,
    budget,
    budgetStart,
    budgetCalls,
    baseContext,
    createEffectiveExecutionContext,
    toolDefinitionRevisionForCall,
    createToolError,
    createToolboxBudgetExceededToolError,
    extractErrorCode,
    isToolAvailable,
    approvalSecret,
    approvalStateStore,
    approvalNow,
    approvalBindingTtlMs,
    approvalNonce,
    toolboxRevision,
    policyRevision,
    approvalRevision,
    createInterruptedResumeApprovalValidationResult,
  } = context;
  async function execute<const TCall extends ToolboxCallInputForTools<ToolsFromEntries<TEntries>>>(
    call: TCall,
    options?: ToolboxExecuteOptions,
  ): Promise<ToolboxResultForCall<ToolsFromEntries<TEntries>, TCall>>;
  async function execute<
    const TCalls extends readonly ToolboxCallInputForTools<ToolsFromEntries<TEntries>>[],
  >(
    calls: [...TCalls],
    options?: ToolboxExecuteOptions,
  ): Promise<{
    [K in keyof TCalls]: ToolboxResultForCall<ToolsFromEntries<TEntries>, TCalls[K]>;
  }>;
  async function execute(
    call: ToolCallInput,
    options?: ToolboxExecuteOptions,
  ): Promise<ToolExecutionResult>;
  async function execute(
    calls: ToolCallInput[],
    options?: ToolboxExecuteOptions,
  ): Promise<ToolExecutionResult[]>;
  async function execute(
    input: ToolCallInput | ToolCallInput[],
    options?: InternalToolboxExecuteOptions,
  ): Promise<ToolExecutionResult | ToolExecutionResult[]> {
    const setup = prepareExecution(
      { executionLifecycle, createEffectiveExecutionContext, toolDefinitionRevisionForCall },
      input,
      options,
    );
    options = setup.options;
    const { nowFunction, deadline, suppliedOwnerId, executionHandle } = setup;
    if (deadline !== undefined && deadline <= nowFunction()) {
      executionHandle.abort('deadline', 'Execution deadline exceeded');
    }
    executionHandle.activate();
    options = { ...options, signal: executionHandle.signal };
    const executionState: BatchExecutionState = { pendingChildCallbacks: 0 };
    try {
      return await runExecutionBatch(
        input,
        options ?? {},
        executionHandle,
        suppliedOwnerId,
        nowFunction,
        executionState,
      );
    } finally {
      if (
        executionHandle.snapshot().state !== 'terminal' &&
        executionHandle.snapshot().state !== 'cleanup-pending' &&
        executionHandle.snapshot().state !== 'streaming' &&
        executionState.pendingChildCallbacks === 0
      ) {
        executionHandle.settle();
      }
    }
  }
  async function runExecutionBatch(
    input: ToolCallInput | ToolCallInput[],
    options: InternalToolboxExecuteOptions,
    executionHandle: ReturnType<ExecutionLifecycle['begin']>,
    suppliedOwnerId: string | undefined,
    nowFunction: () => number,
    state: BatchExecutionState,
  ): Promise<ToolExecutionResult | ToolExecutionResult[]> {
    const calls = Array.isArray(input) ? input : [input];
    const isMultiple = Array.isArray(input);
    const hasSingleChild = calls.length === 1;
    const mode = options.mode ?? 'parallel';
    const errorMode = options.errorMode ?? 'collect';
    const limiter = createConcurrencyLimiter(mode === 'sequential' ? 1 : options.concurrency);
    const runTask = <T>(task: () => Promise<T>) => (limiter ? limiter.run(task) : task());
    let liveStreams = 0;
    let executionReturned = false;
    let executionOutput: ToolExecutionResult | ToolExecutionResult[] | undefined;
    // COR-690: the parent settles only once the batch has returned AND every
    // live stream and every started child callback has genuinely finished. A
    // child callback that ignores its abort signal outlives `Promise.all`
    // over the per-call tasks, so its own settlement must be able to finish
    // the parent later.
    const finalizeParent = () => {
      if (!executionReturned || liveStreams !== 0 || state.pendingChildCallbacks !== 0) return;
      const parentState = executionHandle.snapshot().state;
      if (parentState === 'terminal' || parentState === 'unknown-effect') return;
      if (parentState === 'abort-requested' || parentState === 'cleanup-pending') {
        executionHandle.cleanup();
        return;
      }
      executionHandle.settle(executionOutput);
    };
    const finalizeParentStream = () => {
      liveStreams -= 1;
      finalizeParent();
    };
    const tasks = calls.map((call, callIndex) =>
      createExecutionTask(
        {
          runtime,
          executionLifecycle,
          toolsByName,
          getTool,
          resolutionEnabled,
          emit,
          storedConfigurations,
          onDeprecatedToolCalled,
          loopDetectors,
          autoLoopDetector,
          budget,
          budgetStart,
          budgetCalls,
          baseContext,
          createEffectiveExecutionContext,
          createToolError,
          createToolboxBudgetExceededToolError,
          extractErrorCode,
          isToolAvailable,
          approvalSecret,
          approvalStateStore,
          approvalNow,
          approvalBindingTtlMs,
          approvalNonce,
          toolboxRevision,
          policyRevision,
          approvalRevision,
          createInterruptedResumeApprovalValidationResult,
          options,
          hasSingleChild,
          nowFunction,
          executionHandle,
          errorMode,
          callIndex,
          suppliedOwnerId,
          setChildCallbackPending: (pending) => {
            state.pendingChildCallbacks += pending ? 1 : -1;
            if (!pending) finalizeParent();
          },
          incrementLiveStreams: () => {
            liveStreams += 1;
          },
          finalizeParentStream,
        },
        call,
      ),
    );
    let results: ToolExecutionResult[];
    try {
      results = await Promise.all(tasks.map((task) => runTask(task)));
    } catch (error) {
      // COR-690: a `failFast` rejection can leave a sibling callback still
      // running. Mark the batch returned so that callback's own settlement
      // can still finalize the parent instead of stranding it.
      executionReturned = true;
      throw error;
    }
    const output = isMultiple ? results : results[0]!;
    executionOutput = output;
    executionReturned = true;
    if (liveStreams === 0 && state.pendingChildCallbacks === 0) {
      executionHandle.settle(output);
    }
    return output;
  }
  return execute;
}
