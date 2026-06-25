import type { GenerateContext } from '../../types.ts';
import type { ModelRoute, RoutingDecision, RoutingStrategy } from '../types.ts';

/**
 * Composes multiple routing strategies into a single strategy.
 *
 * Strategies are evaluated in order. The first strategy whose returned
 * route name matches an actual route in the available routes wins.
 * If no strategy matches a real route, the last strategy's decision
 * is returned as-is (the caller's fallback logic handles unmatched routes).
 */
export function composeStrategies(...strategies: RoutingStrategy[]): RoutingStrategy {
  return (context: GenerateContext, routes: readonly ModelRoute[]): RoutingDecision => {
    const routeNames = new Set(routes.map((r) => r.name));
    let lastDecision: RoutingDecision | undefined;

    for (const strategy of strategies) {
      const decision = strategy(context, routes);
      lastDecision = decision;

      if (routeNames.has(decision.route)) {
        return decision;
      }
    }

    // Return the last decision even if it didn't match — caller handles fallback
    return lastDecision ?? { route: '', reason: 'No strategies provided' };
  };
}
