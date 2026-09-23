import type {
  HookErrorHandler,
  HookRegistrationOptions,
  RuntimeServices,
} from '@lostgradient/lifecycle';

import { GenerateRetryEvent } from './events';
import { addJitter } from './retry/jitter';
import type { EventDispatcher } from './run-step';
import type {
  GenerateContext,
  GenerateResponse,
  RetryOptions,
  RunOptions,
  SteeringGate,
  StepResult,
  StopCondition,
} from './types';

export function explicitAbortReason(signal: AbortSignal | undefined): string | undefined {
  return typeof signal?.reason === 'string' ? signal.reason : undefined;
}

/**
 * Races a {@link SteeringGate}'s `awaitResume()` against the step's own
 * `AbortSignal` (AB-67's ratified pause/resume gate). Resolves `aborted:
 * true` the moment the signal fires — whether it was already aborted, fires
 * while the gate is awaited, or the gate resolves after an abort already
 * won the race — and `aborted: false` once a matching `resume` releases the
 * gate first. Removes its own abort listener in every case, so a step that
 * pauses and resumes repeatedly never accumulates listeners on a long-lived
 * run-level signal.
 *
 * Exported (alongside {@link normalizeToArray}) so its already-aborted
 * short-circuit is directly unit-testable: `runStep`'s own call site never
 * reaches this function with an already-aborted `signal` (its own abort
 * check immediately precedes the call, with no `await` between them), so
 * that branch needs a direct test of this function to exercise, not a
 * `runStep`-level one.
 */
export async function awaitResumeOrAbort(
  gate: SteeringGate,
  signal: AbortSignal | undefined,
): Promise<{ aborted: boolean }> {
  if (signal?.aborted) {
    return { aborted: true };
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<'abort'>((resolve) => {
    if (!signal) return;
    onAbort = () => resolve('abort');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Pass `signal` through so a real gate implementation can drop its own
  // registered waiter as soon as the signal fires, rather than leaving one
  // registered indefinitely once the abort branch of this race has won.
  const resumePromise = gate.awaitResume(signal).then((): 'resume' => 'resume');

  try {
    const outcome = await Promise.race([resumePromise, abortPromise]);
    return { aborted: outcome === 'abort' };
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export function normalizeToArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Runs a hook via the registry in a fire-and-forget fashion.
 * All handlers execute via Promise.allSettled so individual failures
 * never block the caller. Most callers don't await the returned promise —
 * `void runHookSilently(...)` is the common shape — but AB-204's `closed()`
 * needs to know when a run-owned hook (`onRunComplete`/`onRunAbort`/
 * `onRunError`/`onLLMInput`/`onLLMOutput`) actually finishes, since none of
 * these are otherwise on the run's critical path. Callers that care pass the
 * returned promise to a `hookTracker` (see `StepDeps.hookTracker` and
 * `make*Result`'s `hookTracker` parameter in `run-lifecycle.ts`) so
 * `closed()` can await it before acknowledging cleanup.
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
): Promise<void> {
  if (!hooks?.has(hookName)) return Promise.resolve();
  const handlers = hooks.getHandlers(hookName);
  const settled = Promise.allSettled(
    handlers.map((entry) => {
      const normalized = Promise.resolve((entry.handler as (...a: unknown[]) => unknown)(...args));
      return normalized;
    }),
  );
  return settled.then(() => undefined);
}

/**
 * Applies the same error-handling policy `HookRegistry.run()` applies to a
 * throwing handler — `entry.options.onError`, falling back to the
 * registry-level `onError` (AB-232) — to a handler invoked by a manual
 * `getHandlers()` loop such as `beforeGenerate`'s and `afterGenerate`'s
 * waterfalls below, which cannot use `run()` itself (see the comments at
 * each call site for why).
 *
 * Throws the original error when no error handler applies, or when the
 * resolved handler returns `'abort'` — the caller's `catch` block should let
 * that propagate. Returns normally (to skip to the next handler) when the
 * resolved handler returns `'continue'`.
 */
export function applyWaterfallHandlerErrorPolicy(
  error: unknown,
  hookName: string,
  handlerIndex: number,
  entryOptions: HookRegistrationOptions,
  registryOnError: HookErrorHandler | undefined,
  /** Stable registration identity (COR-567), from the entry being invoked. */
  id: string,
): void {
  const errorHandler = entryOptions.onError ?? registryOnError;
  if (!errorHandler) {
    throw error;
  }
  const decision = errorHandler(error, { hookName, handlerIndex, id });
  if (decision === 'abort') {
    throw error;
  }
  // 'continue' — skip to next handler
}

export async function evaluateStopConditions(
  conditions: StopCondition[],
  context: StepResult,
): Promise<boolean> {
  for (const condition of conditions) {
    const result = await condition(context);
    if (result) return true;
  }
  return false;
}

export async function callGenerateWithRetry(
  generate: RunOptions['generate'],
  context: GenerateContext,
  retry: RetryOptions | undefined,
  emitter: EventDispatcher | undefined,
  runtime: RuntimeServices,
  /**
   * COR-581 — seals a successor effective-context epoch for a retry whose
   * `RetryMutator` genuinely changed the request, and returns its id.
   *
   * Only called when a mutation actually occurred. An unmutated retry
   * re-issues the identical request and correctly consumes the epoch
   * sealed before `generate.started`; minting a successor for it would
   * claim a context change that did not happen.
   */
  sealMutatedEpoch?: (mutatedContext: GenerateContext, attempt: number) => string,
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
          // AB-67: steering desired-configuration is not mutator-overridable,
          // the same rule `beforeGenerate` follows — reapply the value this
          // retry loop started with (`context.steering`, the step's original
          // boundary read) so a mutator that omits or replaces it can never
          // make a later attempt within the same step ignore the override.
          currentContext = { ...mutatedContext, steering: context.steering };
          mutated = true;
          mutationDescription = `Context mutated on attempt ${attempt}`;
        }
      }

      // Seal before dispatching, so the event can carry the epoch the
      // retry will actually be issued under rather than referring
      // forward to one that does not exist yet.
      const mutatedEpochId = mutated ? sealMutatedEpoch?.(currentContext, attempt) : undefined;
      emitter?.dispatch(
        new GenerateRetryEvent(
          currentContext.step,
          attempt,
          error,
          mutated,
          mutationDescription,
          mutatedEpochId,
        ),
      );

      const rawDelay =
        typeof retry.delay === 'function' ? retry.delay(attempt) : (retry.delay ?? 0);
      const delayMs = retry.jitter
        ? addJitter(rawDelay, { maxJitter: retry.maxJitter, random: runtime.random.next })
        : rawDelay;

      if (delayMs > 0) {
        if (currentContext.signal?.aborted) break;
        await (
          retry.sleep ??
          ((milliseconds: number, signal?: AbortSignal) =>
            new Promise<void>((resolve) => {
              const timer = runtime.timers.setTimeout(resolve, milliseconds);
              if (signal) {
                const onAbort = () => {
                  runtime.timers.clearTimeout(timer);
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
