import { Conversation } from 'conversationalist';

import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

/**
 * Metadata key used to store the escalated temperature value in the
 * conversation snapshot. Generate function implementations can read
 * this key from `context.conversation.getSnapshot().metadata` to
 * apply the temperature to the LLM request.
 */
export const RETRY_TEMPERATURE_KEY = 'retryTemperature';

/** Options for the temperature escalation mutator. */
export interface TemperatureEscalationOptions {
  /** Amount to increase temperature per retry attempt. Defaults to 0.2. */
  increment?: number;
  /** Maximum temperature value. Defaults to 1.0. */
  max?: number;
}

/**
 * Creates a retry mutator that increases the temperature on each retry.
 *
 * Since `GenerateContext` does not expose a temperature field directly,
 * the escalated value is stored in the conversation metadata under the
 * `retryTemperature` key. Generate function implementations should read
 * this value and apply it to their LLM request.
 */
export function createTemperatureEscalationMutator(
  options?: TemperatureEscalationOptions,
): RetryMutator {
  const increment = options?.increment ?? 0.2;
  const max = options?.max ?? 1.0;

  return (context: GenerateContext, _error: unknown, attempt: number) => {
    const temperature = Math.min(increment * attempt, max);

    // Build a new conversation with the temperature in metadata
    const snapshot = context.conversation.getSnapshot();
    const updatedHistory = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        [RETRY_TEMPERATURE_KEY]: temperature,
      },
    };

    return {
      ...context,
      conversation: new Conversation(updatedHistory),
    };
  };
}
