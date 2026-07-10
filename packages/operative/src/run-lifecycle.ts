import type { Conversation } from 'conversationalist';

import { estimateCost, getModelPricing } from './cost-estimation';
import { BudgetExceededError, ElicitationDeniedError, GuardrailTripwireError } from './errors';
import {
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  RunStartedEvent,
  RunTripwireEvent,
} from './events';
import {
  DEFAULT_MAXIMUM_STEPS,
  type EventDispatcher,
  runHookSilently,
  type RunState,
} from './run-step';
import type { FinishReason, RunOptions, RunResult, TokenUsage } from './types';

/**
 * Compute a terminal result's `costEstimate` from `RunOptions.costEstimation`.
 * Returns `undefined` — never a fabricated estimate — when no `costEstimation`
 * was supplied, or when its model has no resolvable pricing (checked via
 * `getModelPricing` up front so `estimateCost`'s throw is never reached).
 */
function computeCostEstimate(
  usage: TokenUsage,
  costEstimation: RunOptions['costEstimation'],
): RunResult['costEstimate'] {
  if (!costEstimation) return undefined;
  if (!getModelPricing(costEstimation.model, costEstimation.pricing)) return undefined;
  return estimateCost(usage, costEstimation.model, costEstimation.pricing);
}

/**
 * The run-level lifecycle, factored out of `executeLoop` so the durable
 * driver's run adapter fires the EXACT same events and hooks. This is the
 * one-code-path discipline applied one level up from {@link runStep}: there is a
 * single implementation of `RunStarted`/`RunCompleted`/`RunAborted`/`RunError`
 * emission and the `onRunStart`/`onRunComplete`/`onRunError`/`onRunAbort` hooks,
 * shared by the in-memory loop and the durable path.
 *
 * Gateway depends on this contract precisely: it wires
 * `activeRun.once('run.completed' | 'run.aborted' | 'run.error')` and
 * `store.register(activeRun, runId)` on these run-level events. A durable run
 * that did not fire them would complete invisibly to gateway — the run would
 * never be marked complete and the session never saved.
 */

/**
 * Emit `RunStartedEvent` and run the `onRunStart` hook. The hook is sequential
 * and an error aborts the run, so this returns the error (rather than throwing)
 * for the caller to convert into an error result via {@link makeErrorResult}.
 *
 * @returns the hook error if `onRunStart` threw, otherwise `undefined`.
 */
export async function startRunLifecycle(
  options: Pick<RunOptions, 'hooks' | 'toolbox' | 'maximumSteps'>,
  conversation: Conversation,
  emitter: EventDispatcher | undefined,
): Promise<unknown> {
  emitter?.dispatch(new RunStartedEvent(conversation));

  if (options.hooks?.has('onRunStart')) {
    try {
      await options.hooks.run('onRunStart', {
        conversation,
        toolbox: options.toolbox,
        maximumSteps: options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS,
      });
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(0, error));
      return error;
    }
  }
  return undefined;
}

/**
 * Build the aborted {@link RunResult}: emit `RunAbortedEvent` and fire the
 * `onRunAbort` hook. Mirrors `executeLoop`'s `makeAbortResult`.
 */
export function makeAbortResult(
  runState: RunState,
  conversation: Conversation,
  hooks: RunOptions['hooks'],
  emitter: EventDispatcher | undefined,
  step: number,
  reason?: string,
  costEstimation?: RunOptions['costEstimation'],
): RunResult {
  const costEstimate = computeCostEstimate(runState.totalUsage, costEstimation);
  emitter?.dispatch(
    new RunAbortedEvent(step, conversation, reason, runState.totalUsage, costEstimate),
  );
  runHookSilently(hooks, 'onRunAbort', {
    reason,
    partialSteps: [...runState.steps],
    conversation,
  });
  return {
    conversation,
    steps: runState.steps,
    content: runState.lastContent,
    usage: runState.totalUsage,
    ...(costEstimate ? { costEstimate } : {}),
    finishReason: 'aborted',
  };
}

/**
 * Build the errored {@link RunResult}: fire `onRunError`, then emit
 * `RunCompletedEvent` with the finish reason classified from the error
 * (`elicitation-denied` / `budget-exceeded` / `tripwire` / `error`). Mirrors
 * `executeLoop`'s `makeErrorResult` exactly.
 *
 * When `error` is a {@link GuardrailTripwireError}, this ALSO dispatches a
 * `RunTripwireEvent` (in addition to `RunCompletedEvent`, never instead of it —
 * gateway's `.once('run.completed' | 'run.aborted' | 'run.error')` contract
 * still depends on `RunCompletedEvent` firing) so listeners that only care
 * about tripwires don't have to unpack `result.error` themselves.
 */
export function makeErrorResult(
  runState: RunState,
  conversation: Conversation,
  hooks: RunOptions['hooks'],
  emitter: EventDispatcher | undefined,
  error: unknown,
  costEstimation?: RunOptions['costEstimation'],
): RunResult {
  runHookSilently(hooks, 'onRunError', {
    error,
    partialSteps: [...runState.steps],
    conversation,
  });

  const finishReason: FinishReason =
    error instanceof ElicitationDeniedError
      ? 'elicitation-denied'
      : error instanceof BudgetExceededError
        ? 'budget-exceeded'
        : error instanceof GuardrailTripwireError
          ? 'tripwire'
          : 'error';

  const costEstimate = computeCostEstimate(runState.totalUsage, costEstimation);
  const result: RunResult = {
    conversation,
    steps: runState.steps,
    content: runState.lastContent,
    usage: runState.totalUsage,
    ...(costEstimate ? { costEstimate } : {}),
    finishReason,
    error,
  };
  if (error instanceof GuardrailTripwireError) {
    emitter?.dispatch(
      new RunTripwireEvent(runState.steps.length, {
        guardrailName: error.guardrailName,
        category: error.category,
        phase: error.phase,
        confidence: error.confidence,
        detail: error.detail,
      }),
    );
  }
  emitter?.dispatch(new RunCompletedEvent(result));
  return result;
}

/**
 * Build a successful terminal {@link RunResult} (`stop-condition` or
 * `maximum-steps`): emit `RunCompletedEvent` and fire the `onRunComplete` hook
 * with the total run duration. Mirrors `executeLoop`'s stop / maximum-steps
 * result construction.
 */
export function makeCompletedResult(
  runState: RunState,
  conversation: Conversation,
  hooks: RunOptions['hooks'],
  emitter: EventDispatcher | undefined,
  finishReason: Extract<FinishReason, 'stop-condition' | 'maximum-steps'>,
  runStartTime: number,
  schemaValidation?: { success: boolean; error?: unknown },
  structuredOutput?: unknown,
  costEstimation?: RunOptions['costEstimation'],
): RunResult {
  const costEstimate = computeCostEstimate(runState.totalUsage, costEstimation);
  const result: RunResult = {
    conversation,
    steps: runState.steps,
    content: runState.lastContent,
    usage: runState.totalUsage,
    ...(costEstimate ? { costEstimate } : {}),
    finishReason,
    ...(schemaValidation ? { schemaValidation } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
  emitter?.dispatch(new RunCompletedEvent(result));
  runHookSilently(hooks, 'onRunComplete', {
    result,
    totalDuration: performance.now() - runStartTime,
  });
  return result;
}
