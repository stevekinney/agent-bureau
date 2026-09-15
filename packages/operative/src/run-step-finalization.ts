import type { ToolExecutionResult } from 'armorer';
import { Conversation } from 'conversationalist';
import type { ToolCall } from 'interoperability';

import {
  ResponseSchemaFailedEvent,
  RunErrorEvent,
  StepCompletedEvent,
  StepGeneratedEvent,
} from './events';
import type { EventDispatcher, RunState, StepDeps, StepOutcome } from './run-step';
import { evaluateStopConditions } from './run-step-utilities';
import { validateOutput } from './structured-output/response-schema';
import type { GenerateResponse, StepResult } from './types';

export interface StepFinalizationDependencies {
  deps: StepDeps;
  runState: RunState;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
  response: GenerateResponse;
  materializedToolCalls: ToolCall[];
  results: ToolExecutionResult[];
}

export async function finalizeStep(input: StepFinalizationDependencies): Promise<StepOutcome> {
  const { deps, runState, conversation, step, emitter, response, materializedToolCalls, results } =
    input;
  const { hooks } = deps;
  const { content, usage, metadata } = response;
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

  // Mirrors the onStepHooks/hooks.onStep error handling immediately below:
  // a `StopCondition` that throws (e.g. `createCostBudgetMonitor`'s
  // `onExceeded` raising `BudgetExceededError` to signal a hard stop, per
  // its documented pattern) must produce a classified `'error'` outcome —
  // `makeErrorResult` maps `BudgetExceededError` to `finishReason:
  // 'budget-exceeded'` — not an unhandled rejection that crashes the run.
  //
  // Unlike the onStepHooks/hooks.onStep catches below (which fire AFTER
  // `stepResult` already carries a real `final` verdict), a throw here means
  // the generate call and tool execution for this step already happened —
  // usage was already folded into `runState.totalUsage` above. So this step
  // still gets recorded: `StepCompletedEvent` still fires and `stepResult`
  // still lands in `runState.steps` (with `final: false` — the run is
  // erroring, not cleanly stopping) before returning the error outcome.
  // Otherwise `makeErrorResult`'s `partialSteps: [...runState.steps]` would
  // silently omit the last successfully generated step even though its
  // usage and conversation mutations already occurred — exactly the kind of
  // gap a SIGTERM/graceful-shutdown partial-report consumer (AB-96) can't
  // afford.
  let shouldStop: boolean;
  try {
    shouldStop = await evaluateStopConditions(deps.stopConditions, stepResult);
  } catch (error) {
    emitter?.dispatch(new StepCompletedEvent(stepResult));
    runState.steps.push(stepResult);
    emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
    return { kind: 'error', error, errorKind: 'policy' };
  }
  stepResult.final = shouldStop;

  emitter?.dispatch(new StepCompletedEvent(stepResult));

  if (deps.onStepHooks.length > 0) {
    try {
      for (const hook of deps.onStepHooks) {
        await hook(stepResult);
      }
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
      return { kind: 'error', error, errorKind: 'policy' };
    }
  }
  if (hooks?.has('onStep')) {
    try {
      await hooks.run('onStep', stepResult);
    } catch (error) {
      emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
      return { kind: 'error', error, errorKind: 'policy' };
    }
  }

  runState.steps.push(stepResult);

  // Structured output enforcement: validate on final step. Each candidate
  // (`runState.lastContent`) is parsed with `parseAsync` exactly once here;
  // a retry re-enters this branch on the NEW final text, never re-validating
  // the same candidate (AB-18).
  if (shouldStop && deps.output) {
    const validation = await validateOutput(deps.output, runState.lastContent);
    if (validation.success) {
      return {
        kind: 'stop',
        finishReason: 'stop-condition',
        schemaValidation: { success: true },
        output: validation.value,
      };
    }

    const validationError = validation.error;
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

  if (shouldStop) {
    return { kind: 'stop', finishReason: 'stop-condition' };
  }

  return { kind: 'next' };
}
