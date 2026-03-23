import {
  contentMatches,
  every,
  forked,
  maximumSteps,
  not,
  noToolCalls,
  repeatingToolCalls,
  some,
  tokenBudget,
  toolCalled,
  toolOutcome,
  wallClockTimeout,
} from './predicates';

export type { RepeatingToolCallsOptions, TokenBudgetOptions } from './predicates';
export {
  contentMatches,
  every,
  forked,
  maximumSteps,
  not,
  noToolCalls,
  repeatingToolCalls,
  some,
  tokenBudget,
  toolCalled,
  toolOutcome,
  wallClockTimeout,
} from './predicates';

/**
 * Composable stop condition factories.
 */
export const stopWhen = {
  noToolCalls,
  toolCalled,
  maximumSteps,
  toolOutcome,
  contentMatches,
  every,
  some,
  not,
  forked,
  repeatingToolCalls,
  tokenBudget,
  wallClockTimeout,
} as const;
