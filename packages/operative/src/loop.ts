import { Conversation, isConversation } from 'conversationalist';

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
import { zodToJsonSchema } from './structured-output/zod-to-json-schema';
import type { RunOptions, RunResult, StopCondition } from './types';

export type { EventDispatcher } from './run-step';

/**
 * Derive the immutable {@link StepDeps} bag from {@link RunOptions}. Every value
 * here is computed once and shared by every step of the run — by both the
 * in-memory `executeLoop` driver and the durable workflow driver, so the two
 * never fork the step implementation.
 */
export function buildStepDeps(options: RunOptions): StepDeps {
  const responseFormat = options.responseSchema
    ? ({
        type: 'json_schema' as const,
        schema: zodToJsonSchema(options.responseSchema),
        name: 'response',
      } as const)
    : undefined;

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
    responseSchema: options.responseSchema,
    responseFormat,
    maximumTokens: options.maximumTokens,
    schemaRetries: options.schemaRetries ?? 0,
    schemaRetryMessage: options.schemaRetryMessage,
    parentContext: options.parentContext,
    withTraceContext: options.withTraceContext,
    runId: options.runId,
    defaultToolChoice: options.toolChoice,
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
  };
}

/** Construct the fresh, mutable run-level accumulators for a new run. */
export function createRunState(): RunState {
  return {
    steps: [],
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    schemaAttempts: 0,
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
): Promise<RunResult> {
  const { maximumSteps = DEFAULT_MAXIMUM_STEPS, hooks, onMaximumSteps } = options;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  const deps = buildStepDeps(options);
  const runState = createRunState();

  const runStartTime = performance.now();

  // RunStartedEvent + onRunStart (error aborts the run). Shared with the adapter.
  const startError = await startRunLifecycle(options, conversation, emitter);
  if (startError !== undefined) {
    return makeErrorResult(runState, conversation, hooks, emitter, startError);
  }

  for (let step = 0; step < maximumSteps; step++) {
    const outcome = await runStep(deps, runState, conversation, step, emitter);

    if (outcome.kind === 'abort') {
      return makeAbortResult(runState, conversation, hooks, emitter, step, outcome.reason);
    }
    if (outcome.kind === 'error') {
      return makeErrorResult(runState, conversation, hooks, emitter, outcome.error);
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
      emitter?.dispatch(new RunErrorEvent(runState.steps.length, error));
      return makeErrorResult(runState, conversation, hooks, emitter, error);
    }
  }

  return makeCompletedResult(runState, conversation, hooks, emitter, 'maximum-steps', runStartTime);
}
