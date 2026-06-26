import type { GenerateContext } from '../../types.ts';
import type { ModelRoute, RoutingDecision, RoutingStrategy } from '../types.ts';

/**
 * Options for the step-based routing strategy.
 */
export type StepBasedStrategyOptions = {
  /** Route name for the first step (step 0). */
  first: string;
  /** Route name for intermediate steps. */
  middle: string;
  /** Route name for the final step (when no tool calls are pending). Optional. */
  last?: string;
  /** Step number at which to switch from first to middle. Defaults to 1. */
  middleAfterStep?: number;
};

/**
 * Checks whether tool calls are pending by looking at the last messages
 * in the conversation for tool-call or tool-result messages without
 * a subsequent assistant reply.
 */
function hasToolCallsPending(context: GenerateContext): boolean {
  const history = context.conversation.current;
  const ids: readonly string[] = history.ids ?? [];
  const messages: Readonly<Record<string, { role: string }>> = history.messages ?? {};

  // Walk backwards from the end
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    const message = messages[id];
    if (!message) break;

    if (message.role === 'tool-call' || message.role === 'tool-result') {
      return true;
    }
    if (message.role === 'assistant' || message.role === 'user') {
      return false;
    }
  }

  return false;
}

/**
 * Creates a routing strategy that selects models based on the current step
 * in the agent loop.
 *
 * Step 0 uses `first`, subsequent steps use `middle`, and when `last` is
 * provided, it kicks in when no tool calls are pending (heuristic for the
 * final response step).
 */
export function createStepBasedStrategy(options: StepBasedStrategyOptions): RoutingStrategy {
  const { first, middle, last, middleAfterStep = 1 } = options;

  return (context: GenerateContext, _routes: readonly ModelRoute[]): RoutingDecision => {
    // Step 0 always uses the first route
    if (context.step < middleAfterStep) {
      return { route: first, reason: 'Step-based: first step' };
    }

    // When last is configured and no tool calls are pending, use it
    if (last && !hasToolCallsPending(context)) {
      return { route: last, reason: 'Step-based: last step (no pending tool calls)' };
    }

    return { route: middle, reason: 'Step-based: middle step' };
  };
}
