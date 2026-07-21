import { createToolbox } from 'armorer';

import type { GenerateFunction, RunOptions, StepContext } from './types';

/**
 * Options for `createEarlyStoppingHandler`.
 */
export interface EarlyStoppingHandlerOptions {
  /** The message appended as a user prompt before the final tool-less call. */
  message?: string;
}

const DEFAULT_MESSAGE =
  'You have reached the step limit. Please provide your best answer now based on the information gathered so far.';

/**
 * Creates an `onMaximumSteps` callback that calls the LLM one more time
 * without tools, prompting it to summarize its findings. This is the
 * recommended pattern from production agent loop literature for graceful
 * early stopping.
 */
export function createEarlyStoppingHandler(
  generate: GenerateFunction,
  options?: EarlyStoppingHandlerOptions,
): NonNullable<RunOptions['onMaximumSteps']> {
  const message = options?.message ?? DEFAULT_MESSAGE;

  return async (context: StepContext): Promise<string> => {
    context.conversation.appendUserMessage(message);

    const response = await generate({
      conversation: context.conversation,
      step: context.step,
      signal: context.signal,
      toolbox: createToolbox(),
    });

    return response.content;
  };
}
