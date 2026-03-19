import type { StepResult, StopCondition } from '../types';

/**
 * Stops when the model returns no tool calls (text-only response).
 */
export function noToolCalls(): StopCondition {
  return (context: StepResult) => context.toolCalls.length === 0;
}

/**
 * Stops when a specific tool is called by name.
 */
export function toolCalled(name: string): StopCondition {
  return (context: StepResult) => context.toolCalls.some((call) => call.name === name);
}

/**
 * Stops when the step count reaches the given limit.
 */
export function maximumSteps(limit: number): StopCondition {
  return (context: StepResult) => context.step >= limit - 1;
}

/**
 * Stops when any tool result has the specified outcome.
 */
export function toolOutcome(outcome: 'error' | 'action_required'): StopCondition {
  return (context: StepResult) =>
    context.results.some((result) => result.outcome === outcome);
}

/**
 * Stops when the assistant content matches the given predicate.
 */
export function contentMatches(
  predicate: (content: string) => boolean,
): StopCondition {
  return (context: StepResult) => predicate(context.content);
}

/**
 * Stops only when all conditions are met.
 */
export function every(...conditions: StopCondition[]): StopCondition {
  return async (context: StepResult) => {
    for (const condition of conditions) {
      const result = await condition(context);
      if (!result) return false;
    }
    return true;
  };
}

/**
 * Stops when any condition is met.
 */
export function some(...conditions: StopCondition[]): StopCondition {
  return async (context: StepResult) => {
    for (const condition of conditions) {
      const result = await condition(context);
      if (result) return true;
    }
    return false;
  };
}

/**
 * Inverts a condition.
 */
export function not(condition: StopCondition): StopCondition {
  return async (context: StepResult) => {
    const result = await condition(context);
    return !result;
  };
}
