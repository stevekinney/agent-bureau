import type { GenerateContext } from '../../types.ts';
import type { ModelRoute, RoutingDecision, RoutingStrategy } from '../types.ts';

/**
 * Options for the cost-aware routing strategy.
 */
export type CostAwareStrategyOptions = {
  /** Ratio of spent/budget at which to switch to the cheap model. */
  thresholdRatio: number;
  /** Returns the current budget state. Queried fresh on each call. */
  getBudgetState: () => { spent: number; budget: number };
  /** Route name for the cheaper model. */
  cheap: string;
  /** Route name for the more expensive model. */
  expensive: string;
};

/**
 * Creates a routing strategy that switches to a cheaper model when
 * spending approaches the budget limit.
 *
 * When `spent / budget >= thresholdRatio`, routes to `cheap`. Otherwise
 * routes to `expensive`. Budget state is queried fresh on each call to
 * reflect real-time spending.
 */
export function createCostAwareStrategy(options: CostAwareStrategyOptions): RoutingStrategy {
  const { thresholdRatio, getBudgetState, cheap, expensive } = options;

  return (_context: GenerateContext, _routes: readonly ModelRoute[]): RoutingDecision => {
    const { spent, budget } = getBudgetState();
    const ratio = budget === 0 ? Infinity : spent / budget;

    if (ratio >= thresholdRatio) {
      return {
        route: cheap,
        reason: `Cost-aware: budget ratio ${ratio.toFixed(2)} >= threshold ${thresholdRatio}`,
      };
    }

    return {
      route: expensive,
      reason: `Cost-aware: under budget (${ratio.toFixed(2)} < ${thresholdRatio})`,
    };
  };
}
