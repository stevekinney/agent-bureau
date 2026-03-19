import {
  contentMatches,
  every,
  forked,
  maximumSteps,
  not,
  noToolCalls,
  some,
  toolCalled,
  toolOutcome,
} from './predicates';

export {
  contentMatches,
  every,
  forked,
  maximumSteps,
  not,
  noToolCalls,
  some,
  toolCalled,
  toolOutcome,
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
} as const;
