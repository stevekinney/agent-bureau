import type { ToolCall } from '@lostgradient/tool-protocol';
import type { AnyToolbox, ToolExecutionResult } from 'armorer';
import { Conversation, materializeToolCalls } from 'conversationalist';

import { reclassifyToolError } from './errors';
import {
  RunErrorEvent,
  StepAbortedEvent,
  ToolResultValidatedEvent,
  ToolSettledBubbleEvent,
  ToolsExecutedEvent,
  ToolsExecutingEvent,
} from './events';
import type { ErrorRecoveryAction } from './hooks/types';
import type { EventDispatcher, StepDeps, StepOutcome } from './run-step';
import { dispatchSettledResults, sealDanglingToolCalls } from './run-step-support';
import { explicitAbortReason } from './run-step-utilities';
import type { GenerateResponse } from './types';

export interface ToolExecutionDependencies {
  deps: StepDeps;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
  signal: AbortSignal | undefined;
  stepSignal: AbortSignal;
  abortStep: (reason?: string) => void;
  elicit: ReturnType<typeof import('./run-step-support').createElicit> | undefined;
  toolCallInputs: GenerateResponse['toolCalls'];
  emittedSettledCallIds: Set<string>;
  stepAbortController: AbortController;
  stepToolbox: AnyToolbox;
}

export interface ToolExecutionResultSet {
  materializedToolCalls: ToolCall[];
  results: ToolExecutionResult[];
}

export async function executeTools(
  input: ToolExecutionDependencies,
): Promise<ToolExecutionResultSet | StepOutcome> {
  const {
    deps,
    conversation,
    step,
    emitter,
    signal,
    stepSignal,
    elicit,
    stepToolbox,
    toolCallInputs,
    emittedSettledCallIds,
    stepAbortController,
  } = input;
  const { hooks } = deps;
  let materializedToolCalls: ToolCall[] = [];
  let results: ToolExecutionResult[] = [];

  if (toolCallInputs.length > 0) {
    materializedToolCalls = materializeToolCalls(toolCallInputs);
    conversation.appendToolCalls(materializedToolCalls);

    let callsToExecute = materializedToolCalls;
    let filteredResults: ToolExecutionResult[] = [];

    if (hooks?.has('beforeToolExecution')) {
      try {
        // Iterated by hand rather than dispatched: `beforeToolExecution`
        // waterfalls a FIELD of its context (`toolCalls`) while the rest of
        // the context stays fixed, so the context is rebuilt around each
        // handler's result. `run()` would instead replace the whole context
        // with a bare
        // `ToolCall[]` for the second handler. Invocations still go through
        // `runHandler` so an observer sees them like any dispatched hook.
        for (const entry of hooks.getHandlers('beforeToolExecution')) {
          const beforeContext = {
            conversation,
            step,
            toolCalls: [...callsToExecute],
            elicit,
          };
          const registryResult = await hooks.runHandler('beforeToolExecution', entry, [
            beforeContext,
          ]);
          if (registryResult !== undefined) {
            callsToExecute = registryResult as ToolCall[];
          }
        }
      } catch (error) {
        const sealedResults = await sealDanglingToolCalls(
          conversation,
          deps.collectAsync,
          'Tool execution aborted before a result could be produced (beforeToolExecution hook failed)',
        );
        dispatchSettledResults(
          emitter,
          deps,
          step,
          materializedToolCalls,
          sealedResults,
          emittedSettledCallIds,
        );
        emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
        return { kind: 'error', error, errorKind: 'tool' };
      }
    }

    // A beforeToolExecution hook can legitimately filter the call list down
    // (or to empty) without throwing. Every filtered-out call was already
    // appended to the conversation via appendToolCalls above and now has no
    // path to a result — seal it here rather than leaving it dangling for a
    // later provider replay to choke on.
    if (callsToExecute.length < materializedToolCalls.length) {
      const executingIds = new Set(callsToExecute.map((tc) => tc.id));
      const filteredOutCalls = materializedToolCalls.filter((tc) => !executingIds.has(tc.id));
      const synthesizedResults = await sealDanglingToolCalls(
        conversation,
        deps.collectAsync,
        'Tool execution skipped by beforeToolExecution hook',
        filteredOutCalls,
      );
      dispatchSettledResults(
        emitter,
        deps,
        step,
        filteredOutCalls,
        synthesizedResults,
        emittedSettledCallIds,
      );
      filteredResults = synthesizedResults;
    }

    if (callsToExecute.length > 0) {
      emitter?.dispatch(new ToolsExecutingEvent(step, callsToExecute));
      let executedResults: ToolExecutionResult[] = [];

      try {
        // AB-233/AB-300 — thread the active trace context and a
        // per-execution `executionContext` (this run's child registry, its
        // own run id, and its own delegated-authority grant) through to
        // every tool call. `executionContext` merges the caller's own
        // `deps.executeOptions.executionContext` (if any) under the
        // run-derived fields, so a caller-supplied key survives unless it
        // collides with `childRegistry`/`parentRunId`/`delegatedAuthority`.
        const { concurrency, mode, errorMode, ...baseExecuteOptions } = deps.executeOptions ?? {};
        const toolboxExecuteOptions = {
          ...baseExecuteOptions,
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(mode === undefined ? {} : { mode }),
          ...(errorMode === undefined ? {} : { errorMode }),
          signal: stepSignal,
          // AB-290: stamp this run's own id as `ownerId` on every armorer
          // execution this call dispatches — after the caller's own
          // `executeOptions`, so this run's identity always wins over
          // anything a caller supplied there. `createActiveRun`'s bubble
          // listeners (`create-run.ts`/`active-run-adapter.ts`) filter
          // `tool.started`/`tool.settled`/`tool.progress` by this same id,
          // replacing the old `ownedToolCallIds`/`ToolCall.id` tracking,
          // which was never guaranteed unique across concurrent runs
          // sharing one `Toolbox`.
          ...(deps.runId !== undefined ? { ownerId: deps.runId } : {}),
          ...(deps.parentContext !== undefined ? { traceContext: deps.parentContext } : {}),
          ...(deps.childRegistry !== undefined ||
          deps.runId !== undefined ||
          deps.delegatedAuthority !== undefined
            ? {
                executionContext: {
                  ...deps.executeOptions?.executionContext,
                  ...(deps.childRegistry !== undefined
                    ? { childRegistry: deps.childRegistry }
                    : {}),
                  ...(deps.runId !== undefined ? { parentRunId: deps.runId } : {}),
                  ...(deps.delegatedAuthority !== undefined
                    ? { delegatedAuthority: deps.delegatedAuthority }
                    : {}),
                },
              }
            : {}),
          ...(deps.durableOperationKeys &&
          deps.runId !== undefined &&
          deps.executeOptions?.durableOperationKey === undefined
            ? {
                durableOperationKey: (call: ToolCall, index: number) =>
                  `schedule-safe:${deps.runId}:step-${step}:tool-${index}:${call.name}`,
              }
            : {}),
        };

        const onForwardedSettled = (event: Event) => {
          if (!(event instanceof ToolSettledBubbleEvent)) return;
          if (
            event.runId === deps.runId &&
            callsToExecute.some((call) => call.id === event.toolCallId)
          ) {
            emittedSettledCallIds.add(event.toolCallId);
          }
        };
        const eventTarget = emitter instanceof EventTarget ? emitter : undefined;
        eventTarget?.addEventListener(ToolSettledBubbleEvent.type, onForwardedSettled);
        let executeResult: ToolExecutionResult | ToolExecutionResult[];
        try {
          executeResult =
            deps.parentContext !== undefined && deps.withTraceContext !== undefined
              ? await deps.withTraceContext(deps.parentContext, () =>
                  stepToolbox.execute(
                    callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                    toolboxExecuteOptions,
                  ),
                )
              : await stepToolbox.execute(
                  callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                  toolboxExecuteOptions,
                );
        } finally {
          eventTarget?.removeEventListener(ToolSettledBubbleEvent.type, onForwardedSettled);
        }

        executedResults = Array.isArray(executeResult) ? executeResult : [executeResult];
        results.push(...executedResults);
      } catch (error) {
        // onError recovery for tool execution phase.
        // Iterate handlers manually to avoid waterfall type mismatch.
        // Wrapped in try/catch so a throwing onError handler doesn't
        // bypass the error result path — if the hook itself fails, we
        // fall through to normal error propagation using the original error.
        let recovered = false;
        if (hooks?.has('onError')) {
          try {
            const toolErrorContext = {
              error,
              step,
              phase: 'tool-execution' as const,
              conversation,
              retryCount: 0,
              maxRetries: 0,
            };
            let errorAction: ErrorRecoveryAction | undefined;
            const toolErrorHandlers = hooks.getHandlers('onError');
            for (const entry of toolErrorHandlers) {
              const result = await (
                entry.handler as (
                  context: typeof toolErrorContext,
                ) => Promise<ErrorRecoveryAction | void>
              )(toolErrorContext);
              if (result === undefined) continue;
              errorAction = result;
              break;
            }

            if (errorAction === 'skip') {
              // Append error results for each dangling tool call so the
              // conversation stays valid (tool calls without corresponding
              // tool results break most LLM APIs on the next generate call).
              results = callsToExecute.map((tc) => ({
                callId: tc.id,
                toolCallId: tc.id,
                toolName: tc.name,
                outcome: 'error' as const,
                content: 'Tool execution skipped by onError hook',
                result: 'Tool execution skipped by onError hook',
              }));
              dispatchSettledResults(
                emitter,
                deps,
                step,
                callsToExecute,
                results,
                emittedSettledCallIds,
              );
              recovered = true;
            }
            // 'retry' and 'abort' both propagate for tool execution
          } catch {
            // The onError hook itself threw — fall through to normal error
            // propagation using the original error so that makeErrorResult,
            // onRunError, and RunErrorEvent all fire as expected.
          }
        }
        if (!recovered) {
          const sealedResults = await sealDanglingToolCalls(
            conversation,
            deps.collectAsync,
            'Tool execution failed before a result could be produced',
          );
          dispatchSettledResults(
            emitter,
            deps,
            step,
            callsToExecute,
            sealedResults,
            emittedSettledCallIds,
          );
          // Re-classify a toolbox-level, failFast BUDGET_EXCEEDED rejection
          // to `BudgetExceededError` here, upstream of `makeErrorResult`'s
          // `instanceof` classification, so the run's `finishReason`
          // resolves to `'budget-exceeded'` instead of falling through to
          // `'error'` (AB-231).
          const runError = reclassifyToolError(error);
          emitter?.dispatch(new RunErrorEvent(step, runError, 'tool'));
          return { kind: 'error', error: runError, errorKind: 'tool' };
        }
      }

      // Validate tool results guardrail
      if (hooks?.has('validateToolResult')) {
        try {
          const validatedResults: ToolExecutionResult[] = [];
          for (const originalResult of results) {
            let currentResult = originalResult;
            {
              const snapshot = { ...currentResult };
              const validated = await hooks.run('validateToolResult', currentResult, {
                conversation,
                step,
                toolCalls: callsToExecute,
                results,
                elicit,
              });
              if (validated !== undefined && validated !== currentResult) {
                emitter?.dispatch(new ToolResultValidatedEvent(step, snapshot, validated));
                currentResult = validated;
              }
            }
            validatedResults.push(currentResult);
          }
          results = validatedResults;
        } catch (error) {
          // Validation failed, but the underlying tool execution already
          // produced real results — seal the tool calls with those
          // (unvalidated) results rather than leaving them dangling.
          if (deps.collectAsync) {
            await conversation.appendToolResultsAsync(results);
          } else {
            conversation.appendToolResults(results);
          }
          emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
          return { kind: 'error', error, errorKind: 'tool' };
        }
      }

      if (deps.collectAsync) {
        await conversation.appendToolResultsAsync(results);
      } else {
        conversation.appendToolResults(results);
      }

      emitter?.dispatch(new ToolsExecutedEvent(step, callsToExecute, executedResults));

      if (stepSignal.aborted && !signal?.aborted) {
        emitter?.dispatch(
          new StepAbortedEvent(step, explicitAbortReason(stepAbortController.signal)),
        );
        return { kind: 'continue' };
      }

      if (hooks?.has('afterToolExecution')) {
        try {
          await hooks.run('afterToolExecution', {
            conversation,
            step,
            toolCalls: callsToExecute,
            results,
            elicit,
          });
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error, 'tool'));
          return { kind: 'error', error, errorKind: 'tool' };
        }
      }
    }

    // Filtered calls were sealed above and must not be re-appended or sent
    // through execution result validation. They remain part of the public
    // step result alongside the actual executed results, after hooks have
    // observed only the calls and results that actually executed. Keep this
    // merge outside the execution guard so an all-filtered batch still exposes
    // its sealed results through StepResult and step.completed.
    results.push(...filteredResults);

    // Preserve provider call order for synthesized-only batches as well as
    // mixed executed/skipped batches. StepResult and its terminal event must
    // match the conversation's original tool-call order.
    const resultByCallId = new Map(results.map((result) => [result.toolCallId, result]));
    results = materializedToolCalls
      .map((call) => resultByCallId.get(call.id))
      .filter((result): result is ToolExecutionResult => result !== undefined);
  }

  return { materializedToolCalls, results };
}
