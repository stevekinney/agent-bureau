import type { Toolbox, ToolExecutionResult } from 'armorer';
import { Conversation, materializeToolCalls } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { ZodType } from 'zod';

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
  RunErrorEvent,
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
import { addJitter } from './retry/jitter';
import type { ToolChoice } from './structured-output/types';
import type {
  AfterToolExecutionHook,
  BeforeToolExecutionHook,
  ContextManagementOptions,
  GenerateContext,
  GenerateResponse,
  OnElicitation,
  OnStepHook,
  PrepareStepHook,
  RetryOptions,
  RunOptions,
  SelectToolsHook,
  StepResult,
  StopCondition,
  TokenUsage,
  ValidateResponseHook,
  ValidateToolResultHook,
} from './types';

/**
 * Minimal structural type for an event emitter. The loop and step never depend
 * on the concrete `CompletableEventTarget`; they only dispatch.
 */
export type EventDispatcher = {
  dispatch(event: Event): boolean;
};

/**
 * The default safety bound on step count when {@link RunOptions.maximumSteps} is
 * not set. Shared by every driver — the in-memory `executeLoop`, the run-level
 * lifecycle, and the durable `agentRun` workflow — so the in-memory and durable
 * paths can never silently disagree on how many steps an unbounded run takes.
 */
export const DEFAULT_MAXIMUM_STEPS = 25;

/**
 * The loop-invariant dependencies of a run. Every field is derived once from
 * {@link RunOptions} before the step loop begins and never mutated. Splitting
 * the run's ~20 locals into this immutable bag plus the mutable {@link RunState}
 * is what lets a single step be a self-contained, relocatable unit — and what
 * lets the durable driver checkpoint only the small, cloneable {@link RunState}.
 */
export interface StepDeps {
  readonly generate: RunOptions['generate'];
  readonly toolbox: Toolbox;
  readonly executeOptions: RunOptions['executeOptions'];
  readonly signal: AbortSignal | undefined;
  readonly collectAsync: boolean;
  readonly retry: RetryOptions | undefined;
  readonly backpressure: RunOptions['backpressure'];
  readonly onElicitation: OnElicitation | undefined;
  readonly hooks: RunOptions['hooks'];
  readonly contextManagement: ContextManagementOptions | undefined;
  readonly responseSchema: ZodType | undefined;
  readonly responseFormat: GenerateContext['responseFormat'];
  /** Per-request output token cap passed through to every GenerateContext. */
  readonly maximumTokens: number | undefined;
  readonly schemaRetries: number;
  readonly schemaRetryMessage: RunOptions['schemaRetryMessage'];
  readonly parentContext: unknown;
  readonly withTraceContext: RunOptions['withTraceContext'];
  readonly runId: string | undefined;
  readonly durableOperationKeys: boolean;
  readonly defaultToolChoice: ToolChoice | undefined;
  readonly stopConditions: StopCondition[];
  readonly prepareStepHooks: PrepareStepHook[];
  readonly beforeToolExecutionHooks: BeforeToolExecutionHook[];
  readonly afterToolExecutionHooks: AfterToolExecutionHook[];
  readonly onStepHooks: OnStepHook[];
  readonly selectToolsHooks: SelectToolsHook[];
  readonly validateResponseHooks: ValidateResponseHook[];
  readonly validateToolResultHooks: ValidateToolResultHook[];
  /** Maximum number of retries the onError hook can request per step. */
  readonly maxErrorRetries: number;
}

/**
 * The mutable, run-level accumulators carried across steps. Every field is
 * plain and cloneable so the durable driver can checkpoint it directly. The
 * `Conversation` is the one non-plain piece; it is carried alongside (a live
 * instance in `executeLoop`, rehydrated from a snapshot per step in the durable
 * driver) and never embedded in `RunState`.
 */
export interface RunState {
  steps: StepResult[];
  totalUsage: TokenUsage;
  lastContent: string;
  /** Run-scoped count of structured-output schema retries already consumed. */
  schemaAttempts: number;
}

/**
 * The discriminated result of a single {@link runStep} call. The driver
 * switches on `kind` to reproduce the original loop's control flow:
 *
 * - `next`: the step completed; advance to the next step.
 * - `continue`: re-enter the loop without advancing the run-level result —
 *   used for skipped steps, per-step aborts, and schema-retry re-prompts (the
 *   user message is already appended and `schemaAttempts` already bumped).
 * - `stop`: a stop condition fired; the run finishes successfully.
 * - `abort`: the run-level signal aborted; the driver builds the abort result.
 * - `error`: an error escaped recovery; the driver builds the error result.
 */
export type StepOutcome =
  | { kind: 'next' }
  | { kind: 'continue' }
  | {
      kind: 'stop';
      // A step only ever stops the run by a stop condition firing; `maximum-steps`
      // is decided by the driver's loop bound, not a step.
      finishReason: 'stop-condition';
      schemaValidation?: { success: boolean; error?: unknown };
    }
  | { kind: 'abort'; reason?: string }
  | { kind: 'error'; error: unknown };

export function normalizeToArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Runs a hook via the registry in a fire-and-forget fashion.
 * All handlers execute via Promise.allSettled so individual failures
 * never block the caller. The returned promise is intentionally not
 * awaited — callers should use `void runHookSilently(...)`.
 */
export function runHookSilently<K extends string>(
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
  );
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

async function callGenerateWithRetry(
  generate: RunOptions['generate'],
  context: GenerateContext,
  retry: RetryOptions | undefined,
  emitter: EventDispatcher | undefined,
): Promise<GenerateResponse> {
  if (!retry || retry.attempts <= 1) {
    return generate(context);
  }

  let currentContext = context;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      return await generate(currentContext);
    } catch (error) {
      lastError = error;

      if (attempt >= retry.attempts) break;

      if (retry.shouldRetry) {
        const shouldContinue = await retry.shouldRetry(error, attempt);
        if (!shouldContinue) break;
      }

      // Apply retry mutator if provided
      let mutated = false;
      let mutationDescription: string | undefined;
      if (retry.mutate) {
        const mutatedContext = await retry.mutate(currentContext, error, attempt);
        if (mutatedContext !== undefined) {
          currentContext = mutatedContext;
          mutated = true;
          mutationDescription = `Context mutated on attempt ${attempt}`;
        }
      }

      emitter?.dispatch(
        new GenerateRetryEvent(currentContext.step, attempt, error, mutated, mutationDescription),
      );

      const rawDelay =
        typeof retry.delay === 'function' ? retry.delay(attempt) : (retry.delay ?? 0);
      const delayMs = retry.jitter ? addJitter(rawDelay, { maxJitter: retry.maxJitter }) : rawDelay;

      if (delayMs > 0) {
        if (currentContext.signal?.aborted) break;
        await (
          retry.sleep ??
          ((milliseconds: number, signal?: AbortSignal) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, milliseconds);
              if (signal) {
                const onAbort = () => {
                  clearTimeout(timer);
                  resolve();
                };
                signal.addEventListener('abort', onAbort, { once: true });
              }
            }))
        )(delayMs, currentContext.signal);
        if (currentContext.signal?.aborted) break;
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

/**
 * Executes exactly one iteration of the agent loop against a live
 * {@link Conversation}, mutating it in place and pushing any completed step
 * into `runState.steps`. This is the entire per-step body extracted verbatim
 * from the original `executeLoop` `for` body — generate (with retry, hooks,
 * and the `prepareStep`/`beforeGenerate`/`afterGenerate` waterfall), the
 * `onError` recovery do/while, response validation, tool execution and its
 * `onError` recovery, tool-result validation, the `afterToolExecution` hooks,
 * stop-condition evaluation, and the structured-output schema-retry decision.
 *
 * The single behavioral change versus the inline body is mechanical: where the
 * inline body did `return makeAbortResult(...)`, `return makeErrorResult(...)`,
 * `continue`, or `return runResult`, this returns a discriminated
 * {@link StepOutcome} and lets the driver reproduce that control flow. The
 * schema-retry `continue` (originally `loop.ts:1014`) is an end-of-step
 * decision — the correction user message is appended and `runState.schemaAttempts`
 * is bumped before returning `{ kind: 'continue' }` — so it is a clean step
 * boundary, not mid-step re-entry. That is what makes the durable driver able
 * to call this same function once per `yield*`-delimited step.
 */
export async function runStep(
  deps: StepDeps,
  runState: RunState,
  conversation: Conversation,
  step: number,
  emitter: EventDispatcher | undefined,
): Promise<StepOutcome> {
  const { signal, backpressure, hooks } = deps;

  if (signal?.aborted) {
    return { kind: 'abort', reason: signal.reason as string | undefined };
  }

  // Backpressure: wait before proceeding if the strategy requires it
  if (backpressure) {
    const { delay: backpressureDelay } = backpressure.beforeStep();
    if (backpressureDelay > 0) {
      emitter?.dispatch(new BackpressureAppliedEvent(step, backpressureDelay));
      if (signal?.aborted) {
        return { kind: 'abort', reason: signal.reason as string | undefined };
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
        return { kind: 'abort', reason: signal.reason as string | undefined };
      }
      emitter?.dispatch(new BackpressureReleasedEvent(step));
    }
  }

  const stepAbortController = new AbortController();
  const stepSignal = signal
    ? AbortSignal.any([signal, stepAbortController.signal])
    : stepAbortController.signal;

  const abortStep = stepAbortController.abort.bind(stepAbortController) as (
    reason?: string,
  ) => void;

  const elicit = deps.onElicitation
    ? createElicit(step, deps.onElicitation, conversation, stepSignal, emitter)
    : undefined;

  // Context management: compact if over token threshold
  if (deps.contextManagement) {
    const contextManagement = deps.contextManagement;
    const tokensBefore = contextManagement.tokenEstimator
      ? contextManagement.tokenEstimator(conversation)
      : conversation.estimateTokens();

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
          return { kind: 'error', error };
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
          const tokensAfter = contextManagement.tokenEstimator
            ? contextManagement.tokenEstimator(conversation)
            : conversation.estimateTokens();
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
              return { kind: 'error', error };
            }
          }
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error));
          return { kind: 'error', error };
        }
      }
    }
  }

  emitter?.dispatch(new StepStartedEvent(conversation, step));

  // Resolve per-step toolbox
  let stepToolbox: Toolbox = deps.toolbox;
  for (const hook of deps.selectToolsHooks) {
    stepToolbox = await hook({ conversation, step, signal: stepSignal, abortStep, elicit });
  }
  if (hooks?.has('selectTools')) {
    const selectContext = { conversation, step, signal: stepSignal, abortStep, elicit };
    const registryToolbox = await hooks.run('selectTools', selectContext);
    if (registryToolbox !== undefined) {
      stepToolbox = registryToolbox;
    }
  }

  // Resolve per-step tool choice: hook override → RunOptions default → undefined
  let stepToolChoice: ToolChoice | undefined = deps.defaultToolChoice;
  if (hooks?.has('selectToolChoice')) {
    const selectToolChoiceContext = { conversation, step, signal: stepSignal, abortStep, elicit };
    const hookResult = await hooks.run('selectToolChoice', selectToolChoiceContext);
    if (hookResult !== undefined) {
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
      for (const hook of deps.prepareStepHooks) {
        prepareResult = await hook({ conversation, step, signal: stepSignal, abortStep, elicit });
        if (prepareResult) break;
      }
      if (!prepareResult && hooks?.has('prepareStep')) {
        const prepareContext = { conversation, step, signal: stepSignal, abortStep, elicit };
        const registryResult = await hooks.run('prepareStep', prepareContext);
        if (registryResult !== undefined) {
          prepareResult = registryResult;
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
          responseFormat: deps.responseFormat,
          maximumTokens: deps.maximumTokens,
        };

        if (hooks?.has('beforeGenerate')) {
          const beforeGenContext = {
            conversation,
            step,
            toolbox: stepToolbox,
            toolChoice: stepToolChoice,
            responseFormat: deps.responseFormat,
            signal: stepSignal,
          };
          const beforeGenResult = await hooks.run('beforeGenerate', beforeGenContext);
          if (beforeGenResult !== undefined) {
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
        let durationMilliseconds: number;
        try {
          response =
            deps.parentContext !== undefined && deps.withTraceContext !== undefined
              ? await deps.withTraceContext(deps.parentContext, () =>
                  callGenerateWithRetry(deps.generate, generateContext, deps.retry, emitter),
                )
              : await callGenerateWithRetry(deps.generate, generateContext, deps.retry, emitter);
          durationMilliseconds = performance.now() - generateStart;
        } catch (generateError) {
          durationMilliseconds = performance.now() - generateStart;
          emitter?.dispatch(new GenerateErrorEvent(step, generateError, durationMilliseconds));
          throw generateError;
        }

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
        // This runs outside the generate try/catch so that hook errors are not
        // misreported as generate errors (the LLM call already succeeded).
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
              entry.handler as (context: typeof afterGenContext) => Promise<GenerateResponse | void>
            )(afterGenContext);
            if (handlerResult !== undefined) {
              response = handlerResult;
            }
          }
        }

        emitter?.dispatch(new GenerateCompletedEvent(step, response, durationMilliseconds));
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
      // The hook invocation is wrapped in try/catch so that a throwing
      // onError handler doesn't bypass the error result path — if the
      // hook itself fails, we fall through to normal error propagation
      // using the original error.
      if (hooks?.has('onError')) {
        try {
          const errorContext = {
            error,
            step,
            phase: 'generate' as const,
            conversation,
            retryCount: stepRetryCount,
            maxRetries: deps.maxErrorRetries,
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

          if (errorAction === 'retry' && stepRetryCount < deps.maxErrorRetries) {
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
        } catch {
          // The onError hook itself threw — fall through to normal error
          // propagation using the original error so that makeErrorResult,
          // onRunError, and RunErrorEvent all fire as expected.
        }
      }

      backpressure?.onError(error);
      if (signal?.aborted) {
        return { kind: 'abort', reason: signal.reason as string | undefined };
      }
      emitter?.dispatch(new RunErrorEvent(step, error));
      return { kind: 'error', error };
    }
  } while (shouldRetryStep);

  // If the step was skipped via onError recovery, move to the next step
  if (stepSkipped) return { kind: 'continue' };

  // Validate response guardrail
  if (deps.validateResponseHooks.length > 0) {
    try {
      for (const hook of deps.validateResponseHooks) {
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
      return { kind: 'error', error };
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
      if (validated !== undefined && validated !== response) {
        emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, validated));
        response = validated;
      }
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error));
      return { kind: 'error', error };
    }
  }

  if (signal?.aborted) {
    return { kind: 'abort', reason: signal.reason as string | undefined };
  }

  if (stepSignal.aborted && !signal?.aborted) {
    emitter?.dispatch(
      new StepAbortedEvent(step, stepAbortController.signal.reason as string | undefined),
    );
    return { kind: 'continue' };
  }

  const { content, toolCalls: toolCallInputs, usage, metadata } = response;
  runState.lastContent = content;
  if (usage) {
    runState.totalUsage.prompt += usage.prompt;
    runState.totalUsage.completion += usage.completion;
    runState.totalUsage.total += usage.total;
    // Cache fields are provider-neutral but not universally reported. Only
    // accumulate when this step's usage actually carried the field, and only
    // materialize it on the run total once a step has reported it — an
    // absent field must never be fabricated as `0`.
    if (usage.cacheCreationTokens !== undefined) {
      runState.totalUsage.cacheCreationTokens =
        (runState.totalUsage.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens !== undefined) {
      runState.totalUsage.cacheReadTokens =
        (runState.totalUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
  }
  emitter?.dispatch(new UsageAccumulatedEvent(step, { ...runState.totalUsage }, usage));

  if (content && !response.messageAppended) {
    conversation.appendAssistantMessage(content, metadata);
  }

  let materializedToolCalls: ToolCall[] = [];
  let results: ToolExecutionResult[] = [];

  if (toolCallInputs.length > 0) {
    materializedToolCalls = materializeToolCalls(toolCallInputs);
    conversation.appendToolCalls(materializedToolCalls);

    let callsToExecute = materializedToolCalls;

    if (deps.beforeToolExecutionHooks.length > 0) {
      try {
        for (const hook of deps.beforeToolExecutionHooks) {
          callsToExecute = await hook({
            conversation,
            step,
            toolCalls: [...callsToExecute],
            elicit,
          });
        }
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return { kind: 'error', error };
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
        if (registryResult !== undefined) {
          callsToExecute = registryResult;
        }
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error));
        return { kind: 'error', error };
      }
    }

    if (callsToExecute.length > 0) {
      emitter?.dispatch(new ToolsExecutingEvent(step, callsToExecute));

      try {
        const executeResult =
          deps.parentContext !== undefined && deps.withTraceContext !== undefined
            ? await deps.withTraceContext(deps.parentContext, () =>
                stepToolbox.execute(
                  callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                  {
                    ...deps.executeOptions,
                    signal: stepSignal,
                    ...(deps.durableOperationKeys &&
                    deps.runId !== undefined &&
                    deps.executeOptions?.durableOperationKey === undefined
                      ? {
                          durableOperationKey: (call: ToolCall, index: number) =>
                            `schedule-safe:${deps.runId}:step-${step}:tool-${index}:${call.name}`,
                        }
                      : {}),
                  } as Parameters<typeof stepToolbox.execute>[1],
                ),
              )
            : await stepToolbox.execute(
                callsToExecute as Parameters<typeof stepToolbox.execute>[0],
                {
                  ...deps.executeOptions,
                  signal: stepSignal,
                  ...(deps.durableOperationKeys &&
                  deps.runId !== undefined &&
                  deps.executeOptions?.durableOperationKey === undefined
                    ? {
                        durableOperationKey: (call: ToolCall, index: number) =>
                          `schedule-safe:${deps.runId}:step-${step}:tool-${index}:${call.name}`,
                      }
                    : {}),
                } as Parameters<typeof stepToolbox.execute>[1],
              );

        results = Array.isArray(executeResult) ? executeResult : [executeResult];
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
          emitter?.dispatch(new RunErrorEvent(step, error));
          return { kind: 'error', error };
        }
      }

      // Validate tool results guardrail
      if (deps.validateToolResultHooks.length > 0 || hooks?.has('validateToolResult')) {
        try {
          const validatedResults: ToolExecutionResult[] = [];
          for (const originalResult of results) {
            let currentResult = originalResult;
            for (const hook of deps.validateToolResultHooks) {
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
              if (validated !== undefined && validated !== currentResult) {
                emitter?.dispatch(new ToolResultValidatedEvent(step, snapshot, validated));
                currentResult = validated;
              }
            }
            validatedResults.push(currentResult);
          }
          results = validatedResults;
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error));
          return { kind: 'error', error };
        }
      }

      if (deps.collectAsync) {
        await conversation.appendToolResultsAsync(results);
      } else {
        conversation.appendToolResults(results);
      }

      emitter?.dispatch(new ToolsExecutedEvent(step, callsToExecute, results));

      if (stepSignal.aborted && !signal?.aborted) {
        emitter?.dispatch(
          new StepAbortedEvent(step, stepAbortController.signal.reason as string | undefined),
        );
        return { kind: 'continue' };
      }

      if (deps.afterToolExecutionHooks.length > 0) {
        try {
          for (const hook of deps.afterToolExecutionHooks) {
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
          return { kind: 'error', error };
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
          return { kind: 'error', error };
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

  const shouldStop = await evaluateStopConditions(deps.stopConditions, stepResult);
  stepResult.final = shouldStop;

  emitter?.dispatch(new StepCompletedEvent(stepResult));

  if (deps.onStepHooks.length > 0) {
    try {
      for (const hook of deps.onStepHooks) {
        await hook(stepResult);
      }
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error));
      return { kind: 'error', error };
    }
  }
  if (hooks?.has('onStep')) {
    try {
      await hooks.run('onStep', stepResult);
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error));
      return { kind: 'error', error };
    }
  }

  runState.steps.push(stepResult);

  // Structured output enforcement: validate on final step
  if (shouldStop && deps.responseSchema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(runState.lastContent);
    } catch {
      parsed = runState.lastContent;
    }

    try {
      deps.responseSchema.parse(parsed);
      // Schema validation passed
      return { kind: 'stop', finishReason: 'stop-condition', schemaValidation: { success: true } };
    } catch (validationError) {
      runState.schemaAttempts++;
      if (runState.schemaAttempts <= deps.schemaRetries) {
        emitter?.dispatch(
          new ResponseSchemaFailedEvent(
            step,
            runState.lastContent,
            validationError,
            deps.schemaRetries - runState.schemaAttempts,
          ),
        );
        // Append a user message with the validation error to prompt correction
        const retryMessage = deps.schemaRetryMessage
          ? deps.schemaRetryMessage(validationError, runState.schemaAttempts)
          : `Your response did not match the required schema. Error: ${String(validationError)}. Please try again with a valid response.`;
        conversation.appendUserMessage(retryMessage);
        stepResult.final = false;
        return { kind: 'continue' };
      }

      // Schema retries exhausted
      emitter?.dispatch(
        new ResponseSchemaFailedEvent(step, runState.lastContent, validationError, 0),
      );
      return {
        kind: 'stop',
        finishReason: 'stop-condition',
        schemaValidation: { success: false, error: validationError },
      };
    }
  }

  if (shouldStop) {
    return { kind: 'stop', finishReason: 'stop-condition' };
  }

  return { kind: 'next' };
}
