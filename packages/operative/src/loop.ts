import type { Toolbox, ToolExecutionResult } from 'armorer';
import { Conversation, isConversation, materializeToolCalls } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { ZodType } from 'zod';

import { BudgetExceededError, ElicitationDeniedError } from './errors';
import {
  BackpressureAppliedEvent,
  BackpressureReleasedEvent,
  ContextBudgetWarningEvent,
  ContextCompactedEvent,
  ElicitationRequestedEvent,
  ElicitationResolvedEvent,
  GenerateCompletedEvent,
  GenerateErrorEvent,
  GenerateRetryEvent,
  GenerateStartedEvent,
  ResponseSchemaFailedEvent,
  ResponseValidatedEvent,
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  RunStartedEvent,
  StepAbortedEvent,
  StepCompletedEvent,
  StepGeneratedEvent,
  StepStartedEvent,
  ToolResultValidatedEvent,
  ToolsExecutedEvent,
  ToolsExecutingEvent,
  UsageAccumulatedEvent,
} from './events';
import type { ErrorRecoveryAction } from './hooks/types';
import type { ToolChoice } from './structured-output/types';
import { zodToJsonSchema } from './structured-output/zod-to-json-schema';
import type {
  GenerateContext,
  GenerateResponse,
  OnElicitation,
  RetryOptions,
  RunOptions,
  RunResult,
  StepResult,
  StopCondition,
  TokenUsage,
} from './types';

type EventDispatcher = {
  dispatch(event: Event): boolean;
};

function accumulateUsage(accumulated: TokenUsage, step?: TokenUsage): void {
  if (!step) return;
  accumulated.prompt += step.prompt;
  accumulated.completion += step.completion;
  accumulated.total += step.total;
}

function normalizeToArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Checks whether a HookRegistry.run() result is actually a new value or just
 * the first argument passed through (which happens when every handler returns void).
 */
function isRegistryPassthrough(result: unknown, firstArg: unknown): boolean {
  return result === firstArg;
}

/**
 * Runs a hook via the registry in a fire-and-forget fashion.
 * All handlers execute via Promise.allSettled so individual failures
 * never block the caller. The returned promise is intentionally not
 * awaited — callers should use `void runHookSilently(...)`.
 */
function runHookSilently<K extends string>(
  hooks:
    | {
        has(name: K): boolean;
        getHandlers(name: K): ReadonlyArray<{ handler: (...args: never[]) => unknown }>;
      }
    | undefined,
  hookName: K,
  ...args: unknown[]
): void {
  if (!hooks?.has(hookName)) return;
  const handlers = hooks.getHandlers(hookName);
  void Promise.allSettled(
    handlers.map((entry) =>
      Promise.resolve((entry.handler as (...a: unknown[]) => unknown)(...args)),
    ),
  ).catch(() => {
    // Intentionally ignore errors in silent hooks.
  });
}

function normalizeStopConditions(conditions: RunOptions['stopWhen']): StopCondition[] {
  if (!conditions) return [];
  return Array.isArray(conditions) ? conditions : [conditions];
}

async function evaluateStopConditions(
  conditions: StopCondition[],
  context: StepResult,
): Promise<boolean> {
  for (const condition of conditions) {
    const result = await condition(context);
    if (result) return true;
  }
  return false;
}

function resolveDelay(delay: RetryOptions['delay'], attempt: number): number {
  if (typeof delay === 'function') return delay(attempt);
  return delay ?? 0;
}

async function callGenerateWithRetry(
  generate: RunOptions['generate'],
  context: GenerateContext,
  retry: RetryOptions | undefined,
  emitter: EventDispatcher | undefined,
): Promise<GenerateResponse> {
  if (!retry || retry.attempts <= 1) {
    return generate(context);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      return await generate(context);
    } catch (error) {
      lastError = error;

      if (attempt >= retry.attempts) break;

      if (retry.shouldRetry) {
        const shouldContinue = await retry.shouldRetry(error, attempt);
        if (!shouldContinue) break;
      }

      emitter?.dispatch(new GenerateRetryEvent(context.step, attempt, error));

      const delayMs = resolveDelay(retry.delay, attempt);
      if (delayMs > 0) {
        if (context.signal?.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          if (context.signal) {
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            context.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        if (context.signal?.aborted) break;
      }
    }
  }

  throw lastError;
}

function createElicit(
  step: number,
  onElicitation: OnElicitation,
  conversation: Conversation,
  signal: AbortSignal | undefined,
  emitter: EventDispatcher | undefined,
) {
  return async <T>(message: string, schema: ZodType<T>): Promise<T | null> => {
    emitter?.dispatch(new ElicitationRequestedEvent(step, message));
    const response = await onElicitation({
      message,
      schema,
      context: { conversation, step, signal },
    });
    const accepted = response !== null;
    emitter?.dispatch(new ElicitationResolvedEvent(step, accepted));
    return accepted ? response.data : null;
  };
}

export async function executeLoop(
  options: RunOptions,
  emitter?: EventDispatcher,
): Promise<RunResult> {
  const {
    generate,
    toolbox,
    maximumSteps = 25,
    executeOptions,
    signal,
    collectAsync = false,
    retry,
    backpressure,
    onElicitation,
    hooks,
    contextManagement,
    responseSchema,
    schemaRetries = 0,
    schemaRetryMessage,
    onMaximumSteps,
    parentContext,
    withTraceContext,
    toolChoice: defaultToolChoice,
  } = options;

  const prepareStepHooks = normalizeToArray(options.prepareStep);
  const beforeToolExecutionHooks = normalizeToArray(options.beforeToolExecution);
  const afterToolExecutionHooks = normalizeToArray(options.afterToolExecution);
  const onStepHooks = normalizeToArray(options.onStep);
  const selectToolsHooks = normalizeToArray(options.selectTools);
  const validateResponseHooks = normalizeToArray(options.validateResponse);
  const validateToolResultHooks = normalizeToArray(options.validateToolResult);

  const wrapWithTrace =
    parentContext !== undefined && withTraceContext !== undefined
      ? <T>(fn: () => Promise<T>) => withTraceContext(parentContext, fn)
      : undefined;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  // Bridge responseSchema → responseFormat for providers that support native structured output
  const responseFormat = responseSchema
    ? ({
        type: 'json_schema' as const,
        schema: zodToJsonSchema(responseSchema),
        name: 'response',
      } as const)
    : undefined;

  const stopConditions = normalizeStopConditions(options.stopWhen);
  const steps: StepResult[] = [];
  const totalUsage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
  let lastContent = '';
  let schemaAttempts = 0;

  const makeAbortResult = (step: number, reason?: string): RunResult => {
    emitter?.dispatch(new RunAbortedEvent(step, reason));
    runHookSilently(hooks, 'onRunAbort', { reason, partialSteps: [...steps], conversation });
    return {
      conversation,
      steps,
      content: lastContent,
      usage: totalUsage,
      finishReason: 'aborted',
    };
  };

  const makeErrorResult = (error: unknown): RunResult => {
    runHookSilently(hooks, 'onRunError', { error, partialSteps: [...steps], conversation });
    if (error instanceof ElicitationDeniedError) {
      const result: RunResult = {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'elicitation-denied',
        error,
      };
      emitter?.dispatch(new RunCompletedEvent(result));
      return result;
    }
    if (error instanceof BudgetExceededError) {
      const result: RunResult = {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'budget-exceeded',
        error,
      };
      emitter?.dispatch(new RunCompletedEvent(result));
      return result;
    }
    const result: RunResult = {
      conversation,
      steps,
      content: lastContent,
      usage: totalUsage,
      finishReason: 'error',
      error,
    };
    emitter?.dispatch(new RunCompletedEvent(result));
    return result;
  };

  emitter?.dispatch(new RunStartedEvent(conversation));

  const runStartTime = performance.now();

  // onRunStart: sequential, error aborts run
  if (hooks?.has('onRunStart')) {
    try {
      await hooks.run('onRunStart', { conversation, toolbox, maximumSteps });
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(0, error));
      return makeErrorResult(error);
    }
  }

  /** Maximum number of retries the onError hook can request per step. */
  const maxErrorRetries = 3;

  for (let step = 0; step < maximumSteps; step++) {
    if (signal?.aborted) {
      return makeAbortResult(step, signal.reason as string | undefined);
    }

    // Backpressure: wait before proceeding if the strategy requires it
    if (backpressure) {
      const { delay: backpressureDelay } = backpressure.beforeStep();
      if (backpressureDelay > 0) {
        emitter?.dispatch(new BackpressureAppliedEvent(step, backpressureDelay));
        if (signal?.aborted) {
          return makeAbortResult(step, signal.reason as string | undefined);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backpressureDelay);
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        if (signal?.aborted) {
          return makeAbortResult(step, signal.reason as string | undefined);
        }
        emitter?.dispatch(new BackpressureReleasedEvent(step));
      }
    }

    const stepAbortController = new AbortController();
    const stepSignal = signal
      ? AbortSignal.any([signal, stepAbortController.signal])
      : stepAbortController.signal;

    const abortStep = (reason?: string) => {
      stepAbortController.abort(reason);
    };

    const elicit = onElicitation
      ? createElicit(step, onElicitation, conversation, stepSignal, emitter)
      : undefined;

    // Context management: compact if over token threshold
    if (contextManagement) {
      const estimator =
        contextManagement.tokenEstimator ?? ((c: Conversation) => c.estimateTokens());
      const tokensBefore = estimator(conversation);

      // Emit budget warning when remaining tokens fall below warningThreshold
      const warningThreshold =
        contextManagement.warningThreshold ?? Math.floor(contextManagement.maxTokens * 0.2);
      const remaining = contextManagement.maxTokens - tokensBefore;
      if (remaining <= warningThreshold) {
        emitter?.dispatch(
          new ContextBudgetWarningEvent(step, tokensBefore, remaining, contextManagement.maxTokens),
        );
      }

      // Determine compaction threshold (new field or legacy maxTokens)
      const compactionThreshold =
        contextManagement.compactionThreshold ?? contextManagement.maxTokens;
      if (tokensBefore > compactionThreshold) {
        // Run beforeCompaction hook if registered
        let shouldCompact = true;
        if (hooks?.has('beforeCompaction')) {
          try {
            const hookResult = await hooks.run('beforeCompaction', {
              conversation,
              step,
              budget: {
                maxTokens: contextManagement.maxTokens,
                minimumResponseTokens: contextManagement.minimumResponseTokens ?? 1500,
                warningThreshold,
                compactionThreshold,
                used: tokensBefore,
                remaining,
                exceeds: true,
                warning: remaining <= warningThreshold,
                update() {},
                allocate() {
                  return 0;
                },
                estimate(text: string) {
                  return Math.ceil(text.length / 4);
                },
              },
            });
            if (hookResult === false) {
              shouldCompact = false;
            }
          } catch (error) {
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
        }

        if (shouldCompact) {
          try {
            const messagesBefore = conversation.getMessages().length;
            await contextManagement.onCompact(conversation, {
              conversation,
              step,
              signal: stepSignal,
              abortStep,
              elicit,
            });
            const tokensAfter = estimator(conversation);
            const messagesAfter = conversation.getMessages().length;
            emitter?.dispatch(new ContextCompactedEvent(step, tokensBefore, tokensAfter));

            // Run afterCompaction hook if registered
            if (hooks?.has('afterCompaction')) {
              try {
                await hooks.run('afterCompaction', {
                  conversation,
                  step,
                  messagesRemoved: messagesBefore - messagesAfter,
                  tokensFreed: tokensBefore - tokensAfter,
                });
              } catch (error) {
                emitter?.dispatch(new RunErrorEvent(step, error));
                return makeErrorResult(error);
              }
            }
          } catch (error) {
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
        }
      }
    }

    emitter?.dispatch(new StepStartedEvent(conversation, step));

    // Resolve per-step toolbox
    let stepToolbox: Toolbox = toolbox;
    for (const hook of selectToolsHooks) {
      stepToolbox = await hook({ conversation, step, signal: stepSignal, abortStep, elicit });
    }
    if (hooks?.has('selectTools')) {
      const selectContext = { conversation, step, signal: stepSignal, abortStep, elicit };
      const registryToolbox = await hooks.run('selectTools', selectContext);
      if (registryToolbox !== undefined && !isRegistryPassthrough(registryToolbox, selectContext)) {
        stepToolbox = registryToolbox;
      }
    }

    // Resolve per-step tool choice: hook override → RunOptions default → undefined
    let stepToolChoice: ToolChoice | undefined = defaultToolChoice;
    if (hooks?.has('selectToolChoice')) {
      const selectToolChoiceContext = { conversation, step, signal: stepSignal, abortStep, elicit };
      const hookResult = await hooks.run('selectToolChoice', selectToolChoiceContext);
      if (hookResult !== undefined && !isRegistryPassthrough(hookResult, selectToolChoiceContext)) {
        stepToolChoice = hookResult;
      }
    }

    let response: GenerateResponse = undefined!;
    let stepRetryCount = 0;
    let shouldRetryStep: boolean;
    let stepSkipped = false;
    do {
      shouldRetryStep = false;
      try {
        let prepareResult: GenerateResponse | void = undefined;
        for (const hook of prepareStepHooks) {
          prepareResult = await hook({ conversation, step, signal: stepSignal, abortStep, elicit });
          if (prepareResult) break;
        }
        if (!prepareResult && hooks?.has('prepareStep')) {
          const prepareContext = { conversation, step, signal: stepSignal, abortStep, elicit };
          const registryResult = await hooks.run('prepareStep', prepareContext);
          if (!isRegistryPassthrough(registryResult, prepareContext)) {
            prepareResult = registryResult as GenerateResponse;
          }
        }

        if (prepareResult) {
          response = prepareResult;
        } else {
          // beforeGenerate: waterfall that can modify the generate context
          let generateContext: GenerateContext = {
            conversation,
            step,
            signal: stepSignal,
            toolbox: stepToolbox,
            toolChoice: stepToolChoice,
            responseFormat,
          };

          if (hooks?.has('beforeGenerate')) {
            const beforeGenContext = {
              conversation,
              step,
              toolbox: stepToolbox,
              toolChoice: stepToolChoice,
              responseFormat,
              signal: stepSignal,
            };
            const beforeGenResult = await hooks.run('beforeGenerate', beforeGenContext);
            if (
              beforeGenResult !== undefined &&
              !isRegistryPassthrough(beforeGenResult, beforeGenContext)
            ) {
              generateContext = beforeGenResult;
            }
          }

          // onLLMInput: parallel allSettled, read-only, non-blocking
          runHookSilently(hooks, 'onLLMInput', {
            conversation: generateContext.conversation,
            step: generateContext.step,
            messageCount: generateContext.conversation.getMessages().length,
          });

          emitter?.dispatch(new GenerateStartedEvent(step));
          const generateStart = performance.now();
          try {
            const doGenerate = () =>
              callGenerateWithRetry(generate, generateContext, retry, emitter);
            response = wrapWithTrace ? await wrapWithTrace(doGenerate) : await doGenerate();
            const durationMilliseconds = performance.now() - generateStart;

            // onLLMOutput: parallel allSettled, read-only, non-blocking
            // Use generateContext (which may have been modified by beforeGenerate)
            // for consistency with onLLMInput — both hooks should report the same
            // conversation and step values for a given LLM call.
            runHookSilently(hooks, 'onLLMOutput', {
              conversation: generateContext.conversation,
              step: generateContext.step,
              response: Object.freeze({ ...response }),
              duration: durationMilliseconds,
              usage: response.usage,
            });

            // afterGenerate: waterfall that can modify the response.
            // We iterate handlers manually instead of using hooks.run() because the
            // waterfall pattern in HookRegistry replaces the first argument with the
            // return value. For afterGenerate, the input is AfterGenerateContext but
            // the return is GenerateResponse — using hooks.run() would feed a
            // GenerateResponse where the next handler expects AfterGenerateContext.
            if (hooks?.has('afterGenerate')) {
              const handlers = hooks.getHandlers('afterGenerate');
              for (const entry of handlers) {
                const afterGenContext = {
                  conversation,
                  step,
                  response,
                  duration: durationMilliseconds,
                };
                const handlerResult = await (
                  entry.handler as (
                    context: typeof afterGenContext,
                  ) => Promise<GenerateResponse | void>
                )(afterGenContext);
                if (handlerResult !== undefined) {
                  response = handlerResult;
                }
              }
            }

            emitter?.dispatch(new GenerateCompletedEvent(step, response, durationMilliseconds));
          } catch (generateError) {
            const durationMilliseconds = performance.now() - generateStart;
            emitter?.dispatch(new GenerateErrorEvent(step, generateError, durationMilliseconds));
            throw generateError;
          }
        }
        backpressure?.onSuccess();
      } catch (error) {
        // onError recovery: sequential, first non-void return wins.
        // We always invoke the hook regardless of retry count so it can
        // return 'skip' or 'abort' even after retries are exhausted.
        // We iterate handlers manually instead of using hooks.run() because
        // the waterfall pattern replaces the first argument with the return
        // value. For onError, the input is ErrorContext but the return is
        // ErrorRecoveryAction (a string) — using hooks.run() would feed a
        // string where the next handler expects ErrorContext.
        if (hooks?.has('onError')) {
          const errorContext = {
            error,
            step,
            phase: 'generate' as const,
            conversation,
            retryCount: stepRetryCount,
            maxRetries: maxErrorRetries,
          };
          let errorAction: ErrorRecoveryAction | undefined;
          const handlers = hooks.getHandlers('onError');
          for (const entry of handlers) {
            const result = await (
              entry.handler as (context: typeof errorContext) => Promise<ErrorRecoveryAction | void>
            )(errorContext);
            if (result !== undefined) {
              errorAction = result;
              break; // first non-void return wins
            }
          }

          if (errorAction === 'retry' && stepRetryCount < maxErrorRetries) {
            stepRetryCount++;
            shouldRetryStep = true;
            continue;
          }

          if (errorAction === 'skip') {
            // Skip this step entirely and continue to the next one
            stepSkipped = true;
            backpressure?.onSuccess();
            break;
          }

          // 'abort' or void — let error propagate normally
        }

        backpressure?.onError(error);
        if (signal?.aborted) {
          return makeAbortResult(step, signal.reason as string | undefined);
        }
        emitter?.dispatch(new RunErrorEvent(step, error));
        return makeErrorResult(error);
      }
    } while (shouldRetryStep);

    // If the step was skipped via onError recovery, move to the next step
    if (stepSkipped) continue;

    // Validate response guardrail
    if (validateResponseHooks.length > 0) {
      try {
        for (const hook of validateResponseHooks) {
          const originalResponse = { ...response };
          const validated = await hook(response, {
            conversation,
            step,
            signal: stepSignal,
            abortStep,
            elicit,
          });
          if (validated) {
            emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, validated));
            response = validated;
          }
        }
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return makeErrorResult(error);
      }
    }
    if (hooks?.has('validateResponse')) {
      try {
        const originalResponse = { ...response };
        const validated = await hooks.run('validateResponse', response, {
          conversation,
          step,
          signal: stepSignal,
          abortStep,
          elicit,
        });
        if (validated !== undefined && !isRegistryPassthrough(validated, response)) {
          emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, validated));
          response = validated;
        }
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return makeErrorResult(error);
      }
    }

    if (signal?.aborted) {
      return makeAbortResult(step, signal.reason as string | undefined);
    }

    if (stepSignal.aborted && !signal?.aborted) {
      emitter?.dispatch(
        new StepAbortedEvent(step, stepAbortController.signal.reason as string | undefined),
      );
      continue;
    }

    const { content, toolCalls: toolCallInputs, usage, metadata } = response;
    lastContent = content;
    accumulateUsage(totalUsage, usage);
    emitter?.dispatch(new UsageAccumulatedEvent(step, { ...totalUsage }, usage));

    if (content && !response.messageAppended) {
      conversation.appendAssistantMessage(content, metadata);
    }

    let materializedToolCalls: ToolCall[] = [];
    let results: ToolExecutionResult[] = [];

    if (toolCallInputs.length > 0) {
      materializedToolCalls = materializeToolCalls(toolCallInputs);
      conversation.appendToolCalls(materializedToolCalls);

      let callsToExecute = materializedToolCalls;

      if (beforeToolExecutionHooks.length > 0) {
        try {
          for (const hook of beforeToolExecutionHooks) {
            callsToExecute = await hook({
              conversation,
              step,
              toolCalls: [...callsToExecute],
              elicit,
            });
          }
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error));
          return makeErrorResult(error);
        }
      }
      if (hooks?.has('beforeToolExecution')) {
        try {
          const beforeContext = {
            conversation,
            step,
            toolCalls: [...callsToExecute],
            elicit,
          };
          const registryResult = await hooks.run('beforeToolExecution', beforeContext);
          if (
            registryResult !== undefined &&
            !isRegistryPassthrough(registryResult, beforeContext)
          ) {
            callsToExecute = registryResult;
          }
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error));
          return makeErrorResult(error);
        }
      }

      if (callsToExecute.length > 0) {
        emitter?.dispatch(new ToolsExecutingEvent(step, callsToExecute));

        try {
          const doExecute = () =>
            stepToolbox.execute(
              callsToExecute as Parameters<typeof stepToolbox.execute>[0],
              { ...executeOptions, signal: stepSignal } as Parameters<
                typeof stepToolbox.execute
              >[1],
            );
          const executeResult = wrapWithTrace ? await wrapWithTrace(doExecute) : await doExecute();

          results = Array.isArray(executeResult) ? executeResult : [executeResult];
        } catch (error) {
          // onError recovery for tool execution phase.
          // Iterate handlers manually to avoid waterfall type mismatch.
          let recovered = false;
          if (hooks?.has('onError')) {
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
              if (result !== undefined) {
                errorAction = result;
                break;
              }
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
              recovered = true;
            }
            // 'retry' and 'abort' both propagate for tool execution
          }
          if (!recovered) {
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
        }

        // Validate tool results guardrail
        if (validateToolResultHooks.length > 0 || hooks?.has('validateToolResult')) {
          try {
            const validatedResults: ToolExecutionResult[] = [];
            for (const originalResult of results) {
              let currentResult = originalResult;
              for (const hook of validateToolResultHooks) {
                const snapshot = { ...currentResult };
                const validated = await hook(currentResult, {
                  conversation,
                  step,
                  toolCalls: callsToExecute,
                  results,
                  elicit,
                });
                if (validated) {
                  emitter?.dispatch(new ToolResultValidatedEvent(step, snapshot, validated));
                  currentResult = validated;
                }
              }
              if (hooks?.has('validateToolResult')) {
                const snapshot = { ...currentResult };
                const validated = await hooks.run('validateToolResult', currentResult, {
                  conversation,
                  step,
                  toolCalls: callsToExecute,
                  results,
                  elicit,
                });
                if (validated !== undefined && !isRegistryPassthrough(validated, currentResult)) {
                  emitter?.dispatch(new ToolResultValidatedEvent(step, snapshot, validated));
                  currentResult = validated;
                }
              }
              validatedResults.push(currentResult);
            }
            results = validatedResults;
          } catch (error) {
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
        }

        if (collectAsync) {
          await conversation.appendToolResultsAsync(results);
        } else {
          conversation.appendToolResults(results);
        }

        emitter?.dispatch(new ToolsExecutedEvent(step, callsToExecute, results));

        if (stepSignal.aborted && !signal?.aborted) {
          emitter?.dispatch(
            new StepAbortedEvent(step, stepAbortController.signal.reason as string | undefined),
          );
          continue;
        }

        if (afterToolExecutionHooks.length > 0) {
          try {
            for (const hook of afterToolExecutionHooks) {
              await hook({
                conversation,
                step,
                toolCalls: callsToExecute,
                results,
                elicit,
              });
            }
          } catch (error) {
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
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
            emitter?.dispatch(new RunErrorEvent(step, error));
            return makeErrorResult(error);
          }
        }
      }
    }

    emitter?.dispatch(
      new StepGeneratedEvent({
        step,
        content,
        toolCalls: materializedToolCalls,
        usage,
      }),
    );

    const stepResult: StepResult = {
      step,
      conversation,
      content,
      toolCalls: materializedToolCalls,
      results,
      usage,
      metadata,
      final: false,
    };

    const shouldStop = await evaluateStopConditions(stopConditions, stepResult);
    stepResult.final = shouldStop;

    emitter?.dispatch(new StepCompletedEvent(stepResult));

    if (onStepHooks.length > 0) {
      try {
        for (const hook of onStepHooks) {
          await hook(stepResult);
        }
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return makeErrorResult(error);
      }
    }
    if (hooks?.has('onStep')) {
      try {
        await hooks.run('onStep', stepResult);
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return makeErrorResult(error);
      }
    }

    steps.push(stepResult);

    // Structured output enforcement: validate on final step
    if (shouldStop && responseSchema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lastContent);
      } catch {
        parsed = lastContent;
      }

      try {
        responseSchema.parse(parsed);
        // Schema validation passed
        const runResult: RunResult = {
          conversation,
          steps,
          content: lastContent,
          usage: totalUsage,
          finishReason: 'stop-condition',
          schemaValidation: { success: true },
        };
        emitter?.dispatch(new RunCompletedEvent(runResult));
        runHookSilently(hooks, 'onRunComplete', {
          result: runResult,
          totalDuration: performance.now() - runStartTime,
        });
        return runResult;
      } catch (validationError) {
        schemaAttempts++;
        if (schemaAttempts <= schemaRetries) {
          emitter?.dispatch(
            new ResponseSchemaFailedEvent(
              step,
              lastContent,
              validationError,
              schemaRetries - schemaAttempts,
            ),
          );
          // Append a user message with the validation error to prompt correction
          const retryMessage = schemaRetryMessage
            ? schemaRetryMessage(validationError, schemaAttempts)
            : `Your response did not match the required schema. Error: ${String(validationError)}. Please try again with a valid response.`;
          conversation.appendUserMessage(retryMessage);
          stepResult.final = false;
          continue;
        }

        // Schema retries exhausted
        emitter?.dispatch(new ResponseSchemaFailedEvent(step, lastContent, validationError, 0));
        const runResult: RunResult = {
          conversation,
          steps,
          content: lastContent,
          usage: totalUsage,
          finishReason: 'stop-condition',
          schemaValidation: { success: false, error: validationError },
        };
        emitter?.dispatch(new RunCompletedEvent(runResult));
        runHookSilently(hooks, 'onRunComplete', {
          result: runResult,
          totalDuration: performance.now() - runStartTime,
        });
        return runResult;
      }
    }

    if (shouldStop) {
      const runResult: RunResult = {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'stop-condition',
      };
      emitter?.dispatch(new RunCompletedEvent(runResult));
      runHookSilently(hooks, 'onRunComplete', {
        result: runResult,
        totalDuration: performance.now() - runStartTime,
      });
      return runResult;
    }
  }

  if (onMaximumSteps) {
    try {
      const finalContent = await onMaximumSteps({ conversation, step: steps.length, signal });
      if (typeof finalContent === 'string') {
        lastContent = finalContent;
        conversation.appendAssistantMessage(finalContent);
      }
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(steps.length, error));
      return makeErrorResult(error);
    }
  }

  const runResult: RunResult = {
    conversation,
    steps,
    content: lastContent,
    usage: totalUsage,
    finishReason: 'maximum-steps',
  };
  emitter?.dispatch(new RunCompletedEvent(runResult));
  runHookSilently(hooks, 'onRunComplete', {
    result: runResult,
    totalDuration: performance.now() - runStartTime,
  });
  return runResult;
}
