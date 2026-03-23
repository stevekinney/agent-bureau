import type { Toolbox, ToolExecutionResult } from 'armorer';
import { Conversation, isConversation, materializeToolCalls } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { ZodType } from 'zod';

import { BudgetExceededError, ElicitationDeniedError } from './errors';
import type { OperativeEvents, OperativeEventType } from './events';
import type {
  GenerateResponse,
  OnElicitation,
  RetryOptions,
  RunOptions,
  RunResult,
  StepResult,
  StopCondition,
  TokenUsage,
} from './types';

type EventEmitter = {
  emit: <K extends OperativeEventType>(type: K, detail: OperativeEvents[K]) => boolean;
};

function accumulateUsage(accumulated: TokenUsage, step?: TokenUsage): void {
  if (!step) return;
  accumulated.prompt += step.prompt;
  accumulated.completion += step.completion;
  accumulated.total += step.total;
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
  context: { conversation: Conversation; step: number; signal?: AbortSignal; toolbox: Toolbox },
  retry: RetryOptions | undefined,
  emitter: EventEmitter | undefined,
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

      emitter?.emit('generate.retry', { step: context.step, attempt, error });

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
  emitter: EventEmitter | undefined,
) {
  return async <T>(message: string, schema: ZodType<T>): Promise<T | null> => {
    emitter?.emit('elicitation.requested', { step, message });
    const response = await onElicitation({
      message,
      schema,
      context: { conversation, step, signal },
    });
    const accepted = response !== null;
    emitter?.emit('elicitation.resolved', { step, accepted });
    return accepted ? response.data : null;
  };
}

export async function executeLoop(options: RunOptions, emitter?: EventEmitter): Promise<RunResult> {
  const {
    generate,
    toolbox,
    maximumSteps = 25,
    prepareStep,
    beforeToolExecution,
    afterToolExecution,
    onStep,
    executeOptions,
    signal,
    collectAsync = false,
    retry,
    validateResponse,
    validateToolResult,
    selectTools,
    onElicitation,
    contextManagement,
    responseSchema,
    schemaRetries = 0,
    schemaRetryMessage,
    onMaximumSteps,
    parentContext,
    withTraceContext,
  } = options;

  const wrapWithTrace =
    parentContext !== undefined && withTraceContext !== undefined
      ? <T>(fn: () => Promise<T>) => withTraceContext(parentContext, fn)
      : undefined;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  const stopConditions = normalizeStopConditions(options.stopWhen);
  const steps: StepResult[] = [];
  const totalUsage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
  let lastContent = '';
  let schemaAttempts = 0;

  const makeErrorResult = (error: unknown): RunResult => {
    if (error instanceof ElicitationDeniedError) {
      const result: RunResult = {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'elicitation-denied',
        error,
      };
      emitter?.emit('run.completed', result);
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
      emitter?.emit('run.completed', result);
      return result;
    }
    return {
      conversation,
      steps,
      content: lastContent,
      usage: totalUsage,
      finishReason: 'error',
      error,
    };
  };

  emitter?.emit('run.started', { conversation });

  for (let step = 0; step < maximumSteps; step++) {
    if (signal?.aborted) {
      emitter?.emit('run.aborted', { step, reason: signal.reason as string | undefined });
      return {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'aborted',
      };
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
      if (tokensBefore > contextManagement.maxTokens) {
        try {
          await contextManagement.onCompact(conversation, {
            conversation,
            step,
            signal: stepSignal,
            abortStep,
            elicit,
          });
          const tokensAfter = estimator(conversation);
          emitter?.emit('context.compacted', { step, tokensBefore, tokensAfter });
        } catch (error) {
          emitter?.emit('run.error', { step, error });
          return makeErrorResult(error);
        }
      }
    }

    emitter?.emit('step.started', { conversation, step });

    // Resolve per-step toolbox
    const stepToolbox: Toolbox = selectTools
      ? await selectTools({ conversation, step, signal: stepSignal, abortStep, elicit })
      : toolbox;

    let response: GenerateResponse;
    try {
      const prepareResult = prepareStep
        ? await prepareStep({ conversation, step, signal: stepSignal, abortStep, elicit })
        : undefined;

      if (prepareResult) {
        response = prepareResult;
      } else {
        const doGenerate = () =>
          callGenerateWithRetry(
            generate,
            { conversation, step, signal: stepSignal, toolbox: stepToolbox },
            retry,
            emitter,
          );
        response = wrapWithTrace ? await wrapWithTrace(doGenerate) : await doGenerate();
      }
    } catch (error) {
      if (signal?.aborted) {
        emitter?.emit('run.aborted', { step, reason: signal.reason as string | undefined });
        return {
          conversation,
          steps,
          content: lastContent,
          usage: totalUsage,
          finishReason: 'aborted',
        };
      }
      emitter?.emit('run.error', { step, error });
      return makeErrorResult(error);
    }

    // Validate response guardrail
    if (validateResponse) {
      try {
        const originalResponse = { ...response };
        const validated = await validateResponse(response, {
          conversation,
          step,
          signal: stepSignal,
          abortStep,
          elicit,
        });
        if (validated) {
          emitter?.emit('response.validated', { step, original: originalResponse, validated });
          response = validated;
        }
      } catch (error) {
        emitter?.emit('run.error', { step, error });
        return makeErrorResult(error);
      }
    }

    if (signal?.aborted) {
      emitter?.emit('run.aborted', { step, reason: signal.reason as string | undefined });
      return {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'aborted',
      };
    }

    if (stepSignal.aborted && !signal?.aborted) {
      emitter?.emit('step.aborted', {
        step,
        reason: stepAbortController.signal.reason as string | undefined,
      });
      continue;
    }

    const { content, toolCalls: toolCallInputs, usage, metadata } = response;
    lastContent = content;
    accumulateUsage(totalUsage, usage);

    if (content && !response.messageAppended) {
      conversation.appendAssistantMessage(content, metadata);
    }

    let materializedToolCalls: ToolCall[] = [];
    let results: ToolExecutionResult[] = [];

    if (toolCallInputs.length > 0) {
      materializedToolCalls = materializeToolCalls(toolCallInputs);
      conversation.appendToolCalls(materializedToolCalls);

      let callsToExecute = materializedToolCalls;

      if (beforeToolExecution) {
        try {
          callsToExecute = await beforeToolExecution({
            conversation,
            step,
            toolCalls: [...materializedToolCalls],
            elicit,
          });
        } catch (error) {
          emitter?.emit('run.error', { step, error });
          return makeErrorResult(error);
        }
      }

      if (callsToExecute.length > 0) {
        emitter?.emit('tools.executing', {
          step,
          toolCalls: callsToExecute,
        });

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
          emitter?.emit('run.error', { step, error });
          return makeErrorResult(error);
        }

        // Validate tool results guardrail
        if (validateToolResult) {
          try {
            const validatedResults: ToolExecutionResult[] = [];
            for (const result of results) {
              const originalResult = { ...result };
              const validated = await validateToolResult(result, {
                conversation,
                step,
                toolCalls: callsToExecute,
                results,
                elicit,
              });
              if (validated) {
                emitter?.emit('tool-result.validated', {
                  step,
                  original: originalResult,
                  validated,
                });
                validatedResults.push(validated);
              } else {
                validatedResults.push(result);
              }
            }
            results = validatedResults;
          } catch (error) {
            emitter?.emit('run.error', { step, error });
            return makeErrorResult(error);
          }
        }

        if (collectAsync) {
          await conversation.appendToolResultsAsync(results);
        } else {
          conversation.appendToolResults(results);
        }

        emitter?.emit('tools.executed', {
          step,
          toolCalls: callsToExecute,
          results,
        });

        if (stepSignal.aborted && !signal?.aborted) {
          emitter?.emit('step.aborted', {
            step,
            reason: stepAbortController.signal.reason as string | undefined,
          });
          continue;
        }

        if (afterToolExecution) {
          try {
            await afterToolExecution({
              conversation,
              step,
              toolCalls: callsToExecute,
              results,
              elicit,
            });
          } catch (error) {
            emitter?.emit('run.error', { step, error });
            return makeErrorResult(error);
          }
        }
      }
    }

    emitter?.emit('step.generated', {
      step,
      content,
      toolCalls: materializedToolCalls,
      usage,
    });

    const stepResult: StepResult = {
      step,
      conversation,
      content,
      toolCalls: materializedToolCalls,
      results,
      usage,
      final: false,
    };

    const shouldStop = await evaluateStopConditions(stopConditions, stepResult);
    stepResult.final = shouldStop;

    emitter?.emit('step.completed', stepResult);

    if (onStep) {
      try {
        await onStep(stepResult);
      } catch (error) {
        emitter?.emit('run.error', { step, error });
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
        emitter?.emit('run.completed', runResult);
        return runResult;
      } catch (validationError) {
        schemaAttempts++;
        if (schemaAttempts <= schemaRetries) {
          emitter?.emit('response.schema-failed', {
            step,
            content: lastContent,
            error: validationError,
            retriesRemaining: schemaRetries - schemaAttempts,
          });
          // Append a user message with the validation error to prompt correction
          const retryMessage = schemaRetryMessage
            ? schemaRetryMessage(validationError, schemaAttempts)
            : `Your response did not match the required schema. Error: ${String(validationError)}. Please try again with a valid response.`;
          conversation.appendUserMessage(retryMessage);
          stepResult.final = false;
          continue;
        }

        // Schema retries exhausted
        emitter?.emit('response.schema-failed', {
          step,
          content: lastContent,
          error: validationError,
          retriesRemaining: 0,
        });
        const runResult: RunResult = {
          conversation,
          steps,
          content: lastContent,
          usage: totalUsage,
          finishReason: 'stop-condition',
          schemaValidation: { success: false, error: validationError },
        };
        emitter?.emit('run.completed', runResult);
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
      emitter?.emit('run.completed', runResult);
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
      emitter?.emit('run.error', { step: steps.length, error });
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
  emitter?.emit('run.completed', runResult);
  return runResult;
}
