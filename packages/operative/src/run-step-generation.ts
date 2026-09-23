import type { AnyToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { SteeringDesiredState } from './durable/types';
import { GuardrailTripwireError } from './errors';
import { GenerateErrorEvent, GenerateStartedEvent, RunErrorEvent } from './events';
import { composeGenerationSelectionRecord } from './generation-selection-record';
import type { ErrorRecoveryAction } from './hooks/types';
import type { EventDispatcher, StepDeps, StepOutcome } from './run-step';
import { createElicit } from './run-step-support';
import {
  applyWaterfallHandlerErrorPolicy,
  callGenerateWithRetry,
  explicitAbortReason,
  runHookSilently,
} from './run-step-utilities';
import type { ToolChoice } from './structured-output/types';
import type { GenerateContext, GenerateResponse } from './types';

export interface GenerationDependencies {
  deps: StepDeps;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
  stepSignal: AbortSignal;
  abortStep: (reason?: string) => void;
  elicit: ReturnType<typeof createElicit> | undefined;
  steeringDesiredState: SteeringDesiredState | undefined;
  stepToolbox: AnyToolbox;
  stepToolChoice: ToolChoice | undefined;
}

export interface GenerationResult {
  response: GenerateResponse;
  stepSkipped: boolean;
  generateDurationMilliseconds: number | undefined;
}

export async function executeGeneration(
  input: GenerationDependencies,
): Promise<GenerationResult | StepOutcome> {
  const {
    deps,
    conversation,
    step,
    emitter,
    stepSignal,
    abortStep,
    elicit,
    steeringDesiredState,
    stepToolbox,
    stepToolChoice,
  } = input;
  const { hooks, hookTracker, backpressure, signal } = deps;
  let response: GenerateResponse = undefined!;
  let stepRetryCount = 0;
  let shouldRetryStep: boolean;
  let stepSkipped = false;
  // AB-302: hoisted out of the generate block below so `GenerateCompletedEvent`
  // can be dispatched once, AFTER the output-guardrail validation blocks that
  // follow the retry loop (`deps.validateResponseHooks` and the
  // `validateResponse` hook registry) — never immediately after the raw
  // provider response comes back. Reset at the top of every retry iteration:
  // `undefined` after the loop means "no real generate call happened this
  // step" (the `prepareResult` short-circuit below never sets it), which is
  // also the signal the post-loop dispatch uses to skip the event entirely,
  // matching this function's prior behavior of never emitting
  // `generate.completed` for a prepareStep-short-circuited step.
  let generateDurationMilliseconds: number | undefined;
  do {
    shouldRetryStep = false;
    generateDurationMilliseconds = undefined;
    try {
      let prepareResult: GenerateResponse | void = undefined;
      if (hooks?.has('prepareStep')) {
        const prepareContext = { conversation, step, signal: stepSignal, abortStep, elicit };
        // `runFirst`, not `run`: a `prepareStep` handler returns a
        // `GenerateResponse` but receives a `StepContext`, so the waterfall
        // would hand the next handler a response where it expects a context.
        // First answer wins and the rest are skipped.
        const registryResult = await hooks.runFirst('prepareStep', prepareContext);
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
          steering: steeringDesiredState,
        };
        if (hooks?.has('beforeGenerate')) {
          // Iterate handlers manually (the same reason afterGenerate does,
          // below) rather than a single `hooks.run()` call: AB-67 requires
          // re-applying the boundary-read `steering` value after EVERY
          // handler, not only after the waterfall's final result, so an
          // earlier handler that omits or replaces it can never leave a
          // later handler observing missing or forged desired state.
          // `hooks.run()` has no hook between handlers to do that reapply.
          //
          // AB-232: a throwing handler is routed through the same policy
          // `run()` uses — `entry.options.onError`, falling back to the
          // registry-level `onError` exposed via `hooks.onError` — instead
          // of bypassing it, via `applyWaterfallHandlerErrorPolicy` above.
          const handlers = hooks.getHandlers('beforeGenerate');
          let beforeGenContext: GenerateContext = {
            conversation,
            step,
            toolbox: stepToolbox,
            toolChoice: stepToolChoice,
            responseFormat: deps.responseFormat,
            signal: stepSignal,
            steering: steeringDesiredState,
          };
          for (const [index, entry] of handlers.entries()) {
            let handlerResult: GenerateContext | void;
            try {
              // `runHandler`, not `entry.handler(...)` directly: it applies
              // this registry's invocation observation, so a hand-iterated
              // hook is visible to a plan observer exactly as a dispatched
              // one is. Error policy stays here, where this loop's own
              // reapply-steering semantics live.
              handlerResult = (await hooks.runHandler('beforeGenerate', entry, [
                beforeGenContext,
              ])) as GenerateContext | void;
            } catch (error) {
              applyWaterfallHandlerErrorPolicy(
                error,
                'beforeGenerate',
                index,
                entry.options,
                hooks.onError,
                entry.id,
              );
              continue;
            }
            if (handlerResult !== undefined) {
              // AB-67: steering desired-configuration is not hook-overridable.
              // A `beforeGenerate` hook may replace every other field of
              // `GenerateContext`, but the session's boundary-read steering
              // state is re-applied here so a hook can never silently drop
              // or override it — for this handler's own return value, not
              // only the waterfall's last one.
              beforeGenContext = { ...handlerResult, steering: steeringDesiredState };
            }
          }
          generateContext = beforeGenContext;
        }

        // onLLMInput: parallel allSettled, read-only, non-blocking. AB-204:
        // handed to hookTracker so closed() can await it — it can still be
        // running when this run's result settles. `runHookSilently` must
        // run unconditionally here — `hookTracker?.(runHookSilently(...))`
        // would short-circuit optional-call semantics and never evaluate
        // the argument (never fire the hook at all) when hookTracker is
        // undefined.
        const onLLMInputHookPromise = runHookSilently(hooks, 'onLLMInput', {
          conversation: generateContext.conversation,
          step: generateContext.step,
          messageCount: generateContext.conversation.getMessages().length,
        });
        hookTracker?.(onLLMInputHookPromise);

        // COR-581: seal the effective-context epoch here, and nowhere
        // else. This is the last point at which nothing further can change
        // the request — the prepareStep hook waterfall above has run
        // (identity, memory, guardrails), `beforeGenerate` has run, and
        // the short-circuit path that would skip the provider call
        // entirely has already returned. Sealing earlier would produce an
        // epoch that omits sources the model genuinely saw.
        //
        // Inside the retry loop deliberately: a guardrail that sanitizes
        // the user message between attempts changed what the model sees,
        // so the next attempt seals its own epoch.
        const sealedEpoch = deps.contextEpoch?.seal({
          conversation: generateContext.conversation,
          steering: steeringDesiredState,
          plan: deps.selection?.getPlan(),
          toolNames: generateContext.toolbox.tools().map((tool) => tool.name),
          consumer: { runId: deps.runId, step, attempt: stepRetryCount },
        });

        // AB-68: record the configuration this call is issued under. Read
        // from the gate rather than re-planning — `prepareStep` already
        // revalidated it at this step's boundary, so `getPlan()` returns
        // the exact plan this step acted on.
        emitter?.dispatch(
          new GenerateStartedEvent(
            step,
            composeGenerationSelectionRecord(deps.selection?.getPlan(), steeringDesiredState),
            sealedEpoch?.epochId,
          ),
        );
        const generateStart = deps.runtime.monotonic.now();
        let durationMilliseconds: number;
        // COR-581: a provider-level retry whose mutator changed the
        // request seals a successor epoch, referenced from
        // `generate.retry`. Without this the mutation would be invisible —
        // the seal above happens once, before the call, and a mutated
        // retry sends the model something the epoch does not describe.
        const sealMutatedEpoch =
          deps.contextEpoch === undefined
            ? undefined
            : (mutatedContext: GenerateContext, providerAttempt: number): string =>
                deps.contextEpoch!.seal({
                  conversation: mutatedContext.conversation,
                  steering: steeringDesiredState,
                  plan: deps.selection?.getPlan(),
                  toolNames: mutatedContext.toolbox.tools().map((tool) => tool.name),
                  consumer: {
                    runId: deps.runId,
                    step,
                    // Offset past the error-recovery attempt index so a
                    // provider retry and an error-recovery retry of the
                    // same step are never reported as the same attempt.
                    attempt: stepRetryCount + providerAttempt,
                  },
                }).epochId;
        try {
          response =
            deps.parentContext !== undefined && deps.withTraceContext !== undefined
              ? await deps.withTraceContext(deps.parentContext, () =>
                  callGenerateWithRetry(
                    deps.generate,
                    generateContext,
                    deps.retry,
                    emitter,
                    deps.runtime,
                    sealMutatedEpoch,
                  ),
                )
              : await callGenerateWithRetry(
                  deps.generate,
                  generateContext,
                  deps.retry,
                  emitter,
                  deps.runtime,
                  sealMutatedEpoch,
                );
          durationMilliseconds = deps.runtime.monotonic.now() - generateStart;
        } catch (generateError) {
          durationMilliseconds = deps.runtime.monotonic.now() - generateStart;
          emitter?.dispatch(new GenerateErrorEvent(step, generateError, durationMilliseconds));
          throw generateError;
        }

        // onLLMOutput: parallel allSettled, read-only, non-blocking
        // Use generateContext (which may have been modified by beforeGenerate)
        // for consistency with onLLMInput — both hooks should report the same
        // conversation and step values for a given LLM call. AB-204: handed
        // to hookTracker for the same reason as onLLMInput above (and same
        // "call unconditionally, track separately" reasoning).
        const onLLMOutputHookPromise = runHookSilently(hooks, 'onLLMOutput', {
          conversation: generateContext.conversation,
          step: generateContext.step,
          response: Object.freeze({ ...response }),
          duration: durationMilliseconds,
          usage: response.usage,
        });
        hookTracker?.(onLLMOutputHookPromise);

        // afterGenerate: waterfall that can modify the response.
        // This runs outside the generate try/catch so that hook errors are not
        // misreported as generate errors (the LLM call already succeeded).
        // We iterate handlers manually instead of using hooks.run() because the
        // waterfall pattern in HookRegistry replaces the first argument with the
        // return value. For afterGenerate, the input is AfterGenerateContext but
        // the return is GenerateResponse — using hooks.run() would feed a
        // GenerateResponse where the next handler expects AfterGenerateContext.
        //
        // AB-232: a throwing handler is routed through the same policy
        // `run()` uses — `entry.options.onError`, falling back to the
        // registry-level `onError` exposed via `hooks.onError` — instead of
        // bypassing it, via `applyWaterfallHandlerErrorPolicy` above.
        if (hooks?.has('afterGenerate')) {
          const handlers = hooks.getHandlers('afterGenerate');
          for (const [index, entry] of handlers.entries()) {
            const afterGenContext = {
              conversation,
              step,
              response,
              duration: durationMilliseconds,
            };
            let handlerResult: GenerateResponse | void;
            try {
              // Observed invocation — see the `beforeGenerate` loop above.
              handlerResult = (await hooks.runHandler('afterGenerate', entry, [
                afterGenContext,
              ])) as GenerateResponse | void;
            } catch (error) {
              applyWaterfallHandlerErrorPolicy(
                error,
                'afterGenerate',
                index,
                entry.options,
                hooks.onError,
                entry.id,
              );
              continue;
            }
            if (handlerResult !== undefined) {
              response = handlerResult;
            }
          }
        }

        // AB-302: `GenerateCompletedEvent` is no longer dispatched here — see
        // the post-guardrail dispatch after the retry loop below, which fires
        // once for whichever attempt lands `generateDurationMilliseconds`.
        generateDurationMilliseconds = durationMilliseconds;
      }
      backpressure?.onSuccess();
    } catch (error) {
      // A tripwire guardrail (mode: 'tripwire') MUST hard-halt the run — it
      // must not be retried, skipped, or otherwise recovered by a user-supplied
      // `onError` hook, which would silently defeat the tripwire. Bypass onError
      // entirely and propagate straight to the error result, matching how the
      // validateResponse tripwire path (below) never consults onError either.
      if (error instanceof GuardrailTripwireError) {
        backpressure?.onError(error);
        emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
        return { kind: 'error', error, errorKind: 'policy' };
      }

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
            // Observed invocation — see the `beforeGenerate` loop above.
            const result = (await hooks.runHandler('onError', entry, [errorContext])) as
              ErrorRecoveryAction | undefined;
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
        return { kind: 'abort', reason: explicitAbortReason(signal) };
      }
      emitter?.dispatch(new RunErrorEvent(step, error, 'generate'));
      return { kind: 'error', error, errorKind: 'generate' };
    }
  } while (shouldRetryStep);

  return { response, stepSkipped, generateDurationMilliseconds };
}
