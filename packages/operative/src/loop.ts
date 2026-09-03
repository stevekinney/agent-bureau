import type { AnyToolbox } from 'armorer';
import { Conversation, isConversation } from 'conversationalist';
import { createDefaultRuntimeServices } from 'lifecycle';

import { MaximumStepsExceededError } from './errors';
import { RunErrorEvent } from './events';
import {
  makeAbortResult,
  makeCompletedResult,
  makeErrorResult,
  startRunLifecycle,
} from './run-lifecycle';
import {
  DEFAULT_MAXIMUM_STEPS,
  type EventDispatcher,
  normalizeToArray,
  type RunState,
  runStep,
  type StepDeps,
} from './run-step';
import { resolveResponseFormat } from './structured-output/response-schema';
import type { RunOptions, RunResult, StopCondition } from './types';

export type { EventDispatcher } from './run-step';

/**
 * Derive the immutable {@link StepDeps} bag from {@link RunOptions}. Every value
 * here is computed once and shared by every step of the run — by both the
 * in-memory `executeLoop` driver and the durable workflow driver, so the two
 * never fork the step implementation.
 */
export function buildStepDeps(options: RunOptions): StepDeps {
  const responseFormat = resolveResponseFormat(options.output);

  const stopConditions: StopCondition[] = !options.stopWhen
    ? []
    : Array.isArray(options.stopWhen)
      ? options.stopWhen
      : [options.stopWhen];

  return {
    generate: options.generate,
    toolbox: options.toolbox,
    executeOptions: options.executeOptions,
    signal: options.signal,
    collectAsync: options.collectAsync ?? false,
    retry: options.retry,
    backpressure: options.backpressure,
    onElicitation: options.onElicitation,
    hooks: options.hooks,
    contextManagement: options.contextManagement,
    output: options.output,
    responseFormat,
    maximumTokens: options.maximumTokens,
    schemaRetries: options.schemaRetries ?? 0,
    schemaRetryMessage: options.schemaRetryMessage,
    parentContext: options.parentContext,
    withTraceContext: options.withTraceContext,
    runId: options.runId,
    childRegistry: options.childRegistry,
    durableOperationKeys: options.durableOperationKeys ?? false,
    defaultToolChoice: options.toolChoice,
    steering: options.steering,
    selection: options.selection,
    stopConditions,
    prepareStepHooks: normalizeToArray(options.prepareStep),
    beforeToolExecutionHooks: normalizeToArray(options.beforeToolExecution),
    afterToolExecutionHooks: normalizeToArray(options.afterToolExecution),
    onStepHooks: normalizeToArray(options.onStep),
    selectToolsHooks: normalizeToArray(options.selectTools),
    validateResponseHooks: normalizeToArray(options.validateResponse),
    validateToolResultHooks: normalizeToArray(options.validateToolResult),
    /** Maximum number of retries the onError hook can request per step. */
    maxErrorRetries: 3,
    // AB-92/AB-252: `createActiveRun` already resolves and snapshots this
    // onto `options.runtime` exactly once, so this branch is only ever
    // reached by an out-of-scope caller (e.g. the durable driver) that
    // built its own `RunOptions` without going through `createActiveRun` —
    // never a second resolution on the in-memory run path.
    runtime: options.runtime ?? createDefaultRuntimeServices(),
  };
}

/**
 * Construct the fresh, mutable run-level accumulators for a new run.
 *
 * `initialAppliedConfigVersion` seeds `lastAppliedConfigVersion` — normally
 * left at its default of 0 for a run with no steering dependency, or for a
 * reconstruction/recovery call site (AB-199's `SteeringGate.getAppliedFloor`
 * is consulted only at the two brand-new-run call sites: `executeLoop`
 * below and `run-workflow.ts`'s `initialCursor`). Seeding it here, rather
 * than only in those two call sites, keeps `createRunState()` the single
 * source of truth for what "fresh" means.
 */
export function createRunState(initialAppliedConfigVersion = 0): RunState {
  return {
    steps: [],
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    schemaAttempts: 0,
    lastAppliedConfigVersion: initialAppliedConfigVersion,
  };
}

/**
 * The in-memory agent loop driver. It owns the run-level concerns — the
 * `onRunStart`/`onRunComplete` lifecycle (shared with the durable path via
 * `run-lifecycle.ts`), the step `for` loop bounded by `maximumSteps`, the
 * `onMaximumSteps` tail, and the abort/error/complete result construction — and
 * delegates each step's body to {@link runStep}. The durable workflow driver
 * calls the same {@link runStep} once per checkpointed step, so there is exactly
 * one step implementation across the in-memory and durable paths.
 */
export async function executeLoop(
  options: RunOptions,
  emitter?: EventDispatcher,
  // AB-204: forwarded to `buildStepDeps`'s output and to every
  // `make*Result` call below so `createActiveRun`'s `closed()` can await
  // every run-owned hook (`onRunComplete`/`onRunAbort`/`onRunError` here,
  // `onLLMInput`/`onLLMOutput` inside `runStep`) before acknowledging
  // cleanup — see `create-run.ts`'s `pendingHookPromises`.
  hookTracker?: (promise: Promise<unknown>) => void,
  // AB-204: forwarded to `buildStepDeps`'s output — see
  // `StepDeps.trackToolCallIds` and `create-run.ts`'s `ownedToolCallIds`.
  trackToolCallIds?: (ids: readonly string[]) => void,
  // AB-239: notifies the driver's toolbox-event forwarder of each step's
  // resolved toolbox (base or `selectTools`-swapped). Not part of RunOptions —
  // it is a driver-internal wire, not user-facing configuration.
  onStepToolbox?: (toolbox: AnyToolbox) => void,
): Promise<RunResult> {
  const { maximumSteps = DEFAULT_MAXIMUM_STEPS, hooks, onMaximumSteps, costEstimation } = options;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  const deps = { ...buildStepDeps(options), hookTracker, trackToolCallIds, onStepToolbox };
  // AB-199 cross-run dedupe: a brand-new run seeds its dedupe cursor from
  // the gate's own cross-run memory, not always 0, so a `configVersion` a
  // PRIOR run already applied is never re-observed as new by this one.
  const runState = createRunState(options.steering?.getAppliedFloor?.() ?? 0);

  const runStartTime = deps.runtime.monotonic.now();

  // RunStartedEvent + onRunStart (error aborts the run). Shared with the adapter.
  const startError = await startRunLifecycle(options, conversation, emitter);
  if (startError !== undefined) {
    return makeErrorResult(
      runState,
      conversation,
      hooks,
      emitter,
      startError,
      costEstimation,
      undefined,
      hookTracker,
    );
  }

  for (let step = 0; step < maximumSteps; step++) {
    const outcome = await runStep(deps, runState, conversation, step, emitter);
    // AB-239: revert the forwarder to the base toolbox now that the step
    // (which called `onStepToolbox` with its own resolved toolbox) has ended —
    // see `ToolboxEventForwarder`'s JSDoc for why this must happen at the
    // step's actual end, not merely before the next step resolves its own
    // toolbox (a durable step can park for arbitrarily long in between).
    onStepToolbox?.(deps.toolbox);

    if (outcome.kind === 'abort') {
      return makeAbortResult(
        runState,
        conversation,
        hooks,
        emitter,
        step,
        outcome.reason,
        costEstimation,
        undefined,
        hookTracker,
      );
    }
    if (outcome.kind === 'error') {
      return makeErrorResult(
        runState,
        conversation,
        hooks,
        emitter,
        outcome.error,
        costEstimation,
        outcome.errorKind,
        hookTracker,
      );
    }
    if (outcome.kind === 'continue') {
      continue;
    }
    if (outcome.kind === 'stop') {
      return makeCompletedResult(
        runState,
        conversation,
        hooks,
        emitter,
        outcome.finishReason,
        runStartTime,
        outcome.schemaValidation,
        outcome.output,
        costEstimation,
        undefined,
        hookTracker,
        deps.runtime,
      );
    }
    // outcome.kind === 'next' — proceed to the next step
  }

  if (onMaximumSteps) {
    try {
      const finalContent = await onMaximumSteps({
        conversation,
        step: runState.steps.length,
        signal: options.signal,
      });
      if (typeof finalContent === 'string') {
        runState.lastContent = finalContent;
        conversation.appendAssistantMessage(finalContent);
      }
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(runState.steps.length, error, 'policy'));
      return makeErrorResult(
        runState,
        conversation,
        hooks,
        emitter,
        error,
        costEstimation,
        'policy',
        hookTracker,
      );
    }
  }

  return makeCompletedResult(
    runState,
    conversation,
    hooks,
    emitter,
    'maximum-steps',
    runStartTime,
    undefined,
    undefined,
    costEstimation,
    new MaximumStepsExceededError(maximumSteps),
    hookTracker,
    deps.runtime,
  );
}
