import { Conversation, isConversation } from 'conversationalist';

import { BudgetExceededError, ElicitationDeniedError } from './errors';
import { RunAbortedEvent, RunCompletedEvent, RunErrorEvent, RunStartedEvent } from './events';
import {
  type EventDispatcher,
  normalizeToArray,
  runHookSilently,
  type RunState,
  runStep,
  type StepDeps,
} from './run-step';
import { zodToJsonSchema } from './structured-output/zod-to-json-schema';
import type { RunOptions, RunResult, StopCondition, TokenUsage } from './types';

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
    schemaRetries: options.schemaRetries ?? 0,
    schemaRetryMessage: options.schemaRetryMessage,
    parentContext: options.parentContext,
    withTraceContext: options.withTraceContext,
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
 * `onRunStart`/`onRunComplete` lifecycle, the step `for` loop bounded by
 * `maximumSteps`, the `onMaximumSteps` tail, and the abort/error/complete result
 * construction — and delegates each step's body to {@link runStep}. The durable
 * workflow driver calls the same {@link runStep} once per checkpointed step, so
 * there is exactly one step implementation across the in-memory and durable
 * paths.
 */
export async function executeLoop(
  options: RunOptions,
  emitter?: EventDispatcher,
): Promise<RunResult> {
  const { maximumSteps = 25, hooks, toolbox, onMaximumSteps } = options;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  const deps = buildStepDeps(options);
  const runState = createRunState();
  const totalUsage: TokenUsage = runState.totalUsage;

  const makeAbortResult = (step: number, reason?: string): RunResult => {
    emitter?.dispatch(new RunAbortedEvent(step, reason));
    runHookSilently(hooks, 'onRunAbort', {
      reason,
      partialSteps: [...runState.steps],
      conversation,
    });
    return {
      conversation,
      steps: runState.steps,
      content: runState.lastContent,
      usage: totalUsage,
      finishReason: 'aborted',
    };
  };

  const makeErrorResult = (error: unknown): RunResult => {
    runHookSilently(hooks, 'onRunError', {
      error,
      partialSteps: [...runState.steps],
      conversation,
    });
    if (error instanceof ElicitationDeniedError) {
      const result: RunResult = {
        conversation,
        steps: runState.steps,
        content: runState.lastContent,
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
        steps: runState.steps,
        content: runState.lastContent,
        usage: totalUsage,
        finishReason: 'budget-exceeded',
        error,
      };
      emitter?.dispatch(new RunCompletedEvent(result));
      return result;
    }
    const result: RunResult = {
      conversation,
      steps: runState.steps,
      content: runState.lastContent,
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

  for (let step = 0; step < maximumSteps; step++) {
    const outcome = await runStep(deps, runState, conversation, step, emitter);

    if (outcome.kind === 'abort') {
      return makeAbortResult(step, outcome.reason);
    }
    if (outcome.kind === 'error') {
      return makeErrorResult(outcome.error);
    }
    if (outcome.kind === 'continue') {
      continue;
    }
    if (outcome.kind === 'stop') {
      const runResult: RunResult = {
        conversation,
        steps: runState.steps,
        content: runState.lastContent,
        usage: totalUsage,
        finishReason: outcome.finishReason,
        ...(outcome.schemaValidation ? { schemaValidation: outcome.schemaValidation } : {}),
      };
      emitter?.dispatch(new RunCompletedEvent(runResult));
      runHookSilently(hooks, 'onRunComplete', {
        result: runResult,
        totalDuration: performance.now() - runStartTime,
      });
      return runResult;
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
      return makeErrorResult(error);
    }
  }

  const runResult: RunResult = {
    conversation,
    steps: runState.steps,
    content: runState.lastContent,
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
