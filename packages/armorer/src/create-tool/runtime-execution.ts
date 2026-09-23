import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { ToolExecutionIdentity } from '../event-types';
import {
  freezeEffectiveToolExecutionContext,
  freezeToolRequestContext,
  type ToolRequestContext,
} from '../execution-context';
import {
  type ApprovalAdmissionRollback,
  approvalConsumeSymbol,
  executionCallbackStartSymbol,
} from '../internal/approval-resume';
import type {
  RuntimeToolContext,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolContext,
  ToolEventsMap,
} from '../is-tool';
import { ToolProgressEvent } from '../tool-stream-events';
import { isAsyncIterable } from '../type-guards';
import type { ToolExecutionResult } from '../types';
import { createAbortRejection, raceWithSignal, withTimeout } from './cancellation';
import { createKnownToolEvent, identityBearingToolEventTypes } from './events';
import type { InternalToolExecuteOptions } from './execution-options';

type Dispatch = (event: Event) => boolean;

type RuntimeContextInput<E extends ToolEventsMap> = Pick<
  RuntimeExecutionInput<never, E, never>,
  | 'options'
  | 'baseDetail'
  | 'typedToolCall'
  | 'configuration'
  | 'effectiveRequestContext'
  | 'name'
  | 'dispatch'
>;

export type RuntimeExecutionInput<TInput, E extends ToolEventsMap, TReturn> = {
  parsed: TInput;
  typedToolCall: ToolCallWithArguments;
  configuration: ToolConfiguration;
  options: InternalToolExecuteOptions;
  effectiveRequestContext?: ToolRequestContext;
  baseDetail: ToolExecutionIdentity;
  name: string;
  runtime: RuntimeServices;
  dispatch: Dispatch;
  runUserCallback: (params: TInput, context: ToolContext<E>) => Promise<TReturn>;
  handleCancellation: (reason?: unknown) => ToolExecutionResult;
};

export type RuntimeExecutionOutcome<TReturn> =
  { kind: 'pending'; value: Promise<TReturn> } | { kind: 'cancelled'; result: ToolExecutionResult };

export function runRuntimeExecution<TInput, E extends ToolEventsMap, TReturn>(
  input: RuntimeExecutionInput<TInput, E, TReturn>,
): RuntimeExecutionOutcome<TReturn> {
  if (input.options[approvalConsumeSymbol]) {
    return {
      kind: 'pending',
      value: runRuntimeExecutionWithApproval(input),
    };
  }
  return startRuntimeExecution(input, undefined);
}

function startRuntimeExecution<TInput, E extends ToolEventsMap, TReturn>(
  input: RuntimeExecutionInput<TInput, E, TReturn>,
  rollbackApprovalAdmission: ApprovalAdmissionRollback | undefined,
): RuntimeExecutionOutcome<TReturn> {
  const cancellation = cancellationAfterApproval(input, rollbackApprovalAdmission);
  if (cancellation) return cancellation;

  const progress = createProgressReporter(input.options, input.baseDetail, input.dispatch);
  const toolContext = createToolContext(input, progress.reportProgress);
  input.options[executionCallbackStartSymbol]?.();
  const runner = input.runUserCallback(input.parsed, toolContext);
  input.options.callbackPending = true;
  progress.stopWhenSettled(runner);
  trackParentCompletion(input.options, runner);
  trackExecutionHandle(input.options, runner);

  const timed =
    typeof input.options.timeout === 'number'
      ? withTimeout(runner, input.options.timeout, input.options, input.runtime.timers)
      : runner;
  return { kind: 'pending', value: raceWithSignal(timed, input.options.signal) };
}

async function runRuntimeExecutionWithApproval<TInput, E extends ToolEventsMap, TReturn>(
  input: RuntimeExecutionInput<TInput, E, TReturn>,
): Promise<TReturn> {
  const rollbackApprovalAdmission = await input.options[approvalConsumeSymbol]?.();
  const execution = startRuntimeExecution(input, rollbackApprovalAdmission);
  if (execution.kind === 'cancelled') {
    throw createAbortRejection(input.options.signal?.reason);
  }
  return execution.value;
}

function cancellationAfterApproval<TInput, E extends ToolEventsMap, TReturn>(
  input: RuntimeExecutionInput<TInput, E, TReturn>,
  rollbackApprovalAdmission: ApprovalAdmissionRollback | undefined,
): { kind: 'cancelled'; result: ToolExecutionResult } | undefined {
  if (!input.options.signal?.aborted) return undefined;
  if (rollbackApprovalAdmission) void rollbackApprovalAdmission();
  const reason =
    input.options.executionHandle?.snapshot().abortReason ?? input.options.signal.reason;
  if (input.options.executionHandle?.snapshot().abortSource === 'deadline') {
    throw createAbortRejection(reason);
  }
  return { kind: 'cancelled', result: input.handleCancellation(reason) };
}

type ProgressReporter = {
  reportProgress: RuntimeToolContext['progress'];
  stopWhenSettled: (runner: Promise<unknown>) => void;
};

function createProgressReporter(
  options: InternalToolExecuteOptions,
  identity: ToolExecutionIdentity,
  dispatch: Dispatch,
): ProgressReporter {
  let progressActive = true;
  const deactivateProgress = () => {
    progressActive = false;
  };
  options.signal?.addEventListener('abort', deactivateProgress, { once: true });
  const reportProgress: RuntimeToolContext['progress'] = (update) => {
    if (!progressActive || options.signal?.aborted) return;
    dispatch(new ToolProgressEvent({ ...update, ...identity }));
  };
  const stopWhenSettled = (runner: Promise<unknown>) => {
    const stopTrackingProgress = () => {
      options.callbackPending = false;
      options.signal?.removeEventListener('abort', deactivateProgress);
      deactivateProgress();
      return undefined;
    };
    void runner.then(stopTrackingProgress, stopTrackingProgress);
  };
  return { reportProgress, stopWhenSettled };
}

function createToolContext<E extends ToolEventsMap>(
  input: RuntimeContextInput<E>,
  progress: RuntimeToolContext['progress'],
): ToolContext<E> {
  return {
    dispatch: (event) => contextDispatch(event, input.baseDetail, input.dispatch),
    progress,
    meta: createMeta(input.name, input.typedToolCall.id),
    toolCall: input.typedToolCall,
    configuration: input.configuration,
    ...(input.effectiveRequestContext
      ? { requestContext: freezeToolRequestContext(input.effectiveRequestContext) }
      : {}),
    ...effectiveContextOption(input),
    ...(input.options.durableOperationKey !== undefined
      ? { durableOperationKey: input.options.durableOperationKey }
      : {}),
    ...(input.options.signal ? { signal: input.options.signal } : {}),
    ...(input.options.timeout !== undefined ? { timeout: input.options.timeout } : {}),
    ...(input.options.stream !== undefined ? { stream: input.options.stream } : {}),
    ...(input.options.elicit ? { elicit: input.options.elicit } : {}),
    ...(input.options.executionHandle ? { execution: input.options.executionHandle } : {}),
    ...(input.options.traceContext !== undefined
      ? { traceContext: input.options.traceContext }
      : {}),
    ...(input.options.executionContext !== undefined
      ? { executionContext: input.options.executionContext }
      : {}),
  };
}

function createMeta(toolName: string, callId: string): { toolName: string; callId?: string } {
  return callId ? { toolName, callId } : { toolName };
}

function effectiveContextOption<E extends ToolEventsMap>(
  input: RuntimeContextInput<E>,
): Pick<ToolContext<E>, 'effectiveContext'> | {} {
  if (!input.options.effectiveContext) return {};
  return {
    effectiveContext: freezeEffectiveToolExecutionContext({
      ...input.options.effectiveContext,
      ...(input.effectiveRequestContext
        ? {
            ...freezeToolRequestContext(input.effectiveRequestContext),
            revisions: input.options.effectiveContext.revisions,
          }
        : {}),
    }),
  };
}

function contextDispatch(
  event: Event,
  identity: ToolExecutionIdentity,
  dispatch: Dispatch,
): boolean {
  if (!identityBearingToolEventTypes.has(event.type)) {
    return dispatch(event);
  }
  const eventProps = eventOwnProperties(event);
  const stampedEvent = createKnownToolEvent(event.type, { ...eventProps, ...identity });
  return stampedEvent ? dispatch(stampedEvent) : dispatch(event);
}

function eventOwnProperties(event: Event): Record<string, unknown> {
  const eventProps: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(event)) {
    if (key !== 'type' && key !== 'isTrusted') {
      eventProps[key] = Reflect.get(event, key);
    }
  }
  return eventProps;
}

function trackParentCompletion(
  options: InternalToolExecuteOptions,
  runner: Promise<unknown>,
): void {
  if (!options.parentCompletionHandle) return;
  options.onParentCompletionPending?.(true);
  void runner.then(
    (result) => {
      if (!isAsyncIterable(result)) options.parentCompletionHandle?.settle(result);
      options.onParentCompletionPending?.(false);
      return undefined;
    },
    (error) => {
      options.parentCompletionHandle?.settle(error);
      options.onParentCompletionPending?.(false);
      return undefined;
    },
  );
}

function trackExecutionHandle(options: InternalToolExecuteOptions, runner: Promise<unknown>): void {
  if (!options.executionHandle) return;
  void runner.then(
    (result) => {
      settlePendingExecution(options, result);
      return undefined;
    },
    (error) => {
      settlePendingExecution(options, error);
      return undefined;
    },
  );
}

function settlePendingExecution(options: InternalToolExecuteOptions, result: unknown): void {
  const state = options.executionHandle?.snapshot().state;
  if (state === 'abort-requested' || state === 'cleanup-pending') {
    options.executionHandle?.settle(result);
  }
}
