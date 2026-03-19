import type { ToolExecutionResult } from 'armorer';
import { Conversation, materializeToolCalls } from 'conversationalist';
import type { ToolCall } from 'interoperability';

import type { OperativeEvents, OperativeEventType } from './events';
import type {
  GenerateResponse,
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

function normalizeStopConditions(
  conditions: RunOptions['stopWhen'],
): StopCondition[] {
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

function isConversation(value: unknown): value is Conversation {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Conversation).appendAssistantMessage === 'function' &&
    typeof (value as Conversation).appendToolCalls === 'function' &&
    typeof (value as Conversation).appendToolResults === 'function' &&
    'current' in (value as Conversation)
  );
}

export async function executeLoop(
  options: RunOptions,
  emitter?: EventEmitter,
): Promise<RunResult> {
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
  } = options;

  const conversation = isConversation(options.conversation)
    ? options.conversation
    : new Conversation(options.conversation);

  const stopConditions = normalizeStopConditions(options.stopWhen);
  const steps: StepResult[] = [];
  const totalUsage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
  let lastContent = '';

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

    emitter?.emit('step.started', { conversation, step });

    let response: GenerateResponse;
    try {
      const prepareResult = prepareStep
        ? await prepareStep({ conversation, step, signal })
        : undefined;

      if (prepareResult) {
        response = prepareResult;
      } else {
        response = await generate({ conversation, step, signal });
      }
    } catch (error) {
      emitter?.emit('run.error', { step, error });
      return {
        conversation,
        steps,
        content: lastContent,
        usage: totalUsage,
        finishReason: 'error',
      };
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

    const { content, toolCalls: toolCallInputs, usage, metadata } = response;
    lastContent = content;
    accumulateUsage(totalUsage, usage);

    if (content) {
      conversation.appendAssistantMessage(content, metadata);
    }

    let materializedToolCalls: ToolCall[] = [];
    let results: ToolExecutionResult[] = [];

    emitter?.emit('step.generated', {
      step,
      content,
      toolCalls: [],
      usage,
    });

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
          });
        } catch (error) {
          emitter?.emit('run.error', { step, error });
          return {
            conversation,
            steps,
            content: lastContent,
            usage: totalUsage,
            finishReason: 'error',
          };
        }
      }

      if (callsToExecute.length > 0) {
        emitter?.emit('tools.executing', {
          step,
          toolCalls: callsToExecute,
        });

        try {
          const executeResult = await toolbox.execute(
            callsToExecute as Parameters<typeof toolbox.execute>[0],
            { ...executeOptions, signal } as Parameters<typeof toolbox.execute>[1],
          );

          results = Array.isArray(executeResult)
            ? executeResult
            : [executeResult];
        } catch (error) {
          emitter?.emit('run.error', { step, error });
          return {
            conversation,
            steps,
            content: lastContent,
            usage: totalUsage,
            finishReason: 'error',
          };
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

        if (afterToolExecution) {
          try {
            await afterToolExecution({
              conversation,
              step,
              toolCalls: callsToExecute,
              results,
            });
          } catch (error) {
            emitter?.emit('run.error', { step, error });
            return {
              conversation,
              steps,
              content: lastContent,
              usage: totalUsage,
              finishReason: 'error',
            };
          }
        }
      }
    }

    // Update the step.generated event with actual materialized tool calls
    // (emitted above with empty array; the real tool calls are in tools.executing)

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
        return {
          conversation,
          steps,
          content: lastContent,
          usage: totalUsage,
          finishReason: 'error',
        };
      }
    }

    steps.push(stepResult);

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
