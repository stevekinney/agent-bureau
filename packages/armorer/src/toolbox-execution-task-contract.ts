import type { ExecutionHandle } from './execution-lifecycle';
import { approvalConsumeSymbol } from './internal/approval-resume';
import type { InternalToolboxExecuteOptions } from './toolbox-contracts';
import type { ExecutorContext } from './toolbox-execution';

export type ExecutionTaskContext = Pick<
  ExecutorContext,
  | 'runtime'
  | 'executionLifecycle'
  | 'toolsByName'
  | 'getTool'
  | 'resolutionEnabled'
  | 'emit'
  | 'storedConfigurations'
  | 'onDeprecatedToolCalled'
  | 'loopDetectors'
  | 'autoLoopDetector'
  | 'budget'
  | 'budgetStart'
  | 'budgetCalls'
  | 'baseContext'
  | 'createEffectiveExecutionContext'
  | 'createToolError'
  | 'createToolboxBudgetExceededToolError'
  | 'extractErrorCode'
  | 'isToolAvailable'
  | 'approvalSecret'
  | 'approvalStateStore'
  | 'approvalNow'
  | 'approvalBindingTtlMs'
  | 'approvalNonce'
  | 'toolboxRevision'
  | 'policyRevision'
  | 'approvalRevision'
  | 'createInterruptedResumeApprovalValidationResult'
> & {
  readonly options: InternalToolboxExecuteOptions & { [approvalConsumeSymbol]?: unknown };
  readonly hasSingleChild: boolean;
  readonly nowFunction: () => number;
  readonly executionHandle: ExecutionHandle;
  readonly errorMode: 'failFast' | 'collect';
  readonly callIndex: number;
  readonly setChildCallbackPending: (pending: boolean) => void;
  readonly incrementLiveStreams: () => void;
  readonly finalizeParentStream: () => void;
  readonly suppliedOwnerId: string | undefined;
};
