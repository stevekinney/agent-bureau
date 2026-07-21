import type { CostBudgetOptions } from '../cost-budget-monitor';
import { createCostBudgetMonitor } from '../cost-budget-monitor';
import type { StopCondition } from '../types';
import {
  contentMatches,
  every,
  forked,
  maximumSteps,
  not,
  noToolCalls,
  pendingApproval,
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
  pendingApproval,
  repeatingToolCalls,
  some,
  tokenBudget,
  toolCalled,
  toolOutcome,
  wallClockTimeout,
} from './predicates';

/**
 * Creates a stop condition that halts the loop when the accumulated
 * dollar cost reaches the given budget. Threshold and exceeded callbacks
 * are forwarded to the underlying `CostBudgetMonitor`.
 */
function costBudget(options: CostBudgetOptions): StopCondition {
  const monitor = createCostBudgetMonitor(options);
  return monitor.stopCondition;
}

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
  costBudget,
  pendingApproval,
} as const;
