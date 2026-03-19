export {
  contentMatches,
  every,
  maximumSteps,
  not,
  noToolCalls,
  some,
  toolCalled,
  toolOutcome,
} from './predicates';

import {
  contentMatches,
  every,
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
} as const;
