import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import type { RoutingOptions } from './types.ts';

/**
 * Creates a GenerateFunction that routes each call to a different model
 * based on the provided strategy.
 *
 * The strategy inspects the GenerateContext and selects a route by name.
 * If the selected route doesn't exist, the fallback route is used instead.
 * Context and response pass through unchanged — routing is transparent to
 * the caller and the model.
 */
export function createRoutingGenerate(options: RoutingOptions): GenerateFunction {
  const { routes, strategy, onRoute, fallback } = options;
  const routeMap = new Map(routes.map((r) => [r.name, r]));

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const decision = strategy(context, routes);
    let selectedRoute = routeMap.get(decision.route);

    if (!selectedRoute) {
      selectedRoute = routeMap.get(fallback);
    }

    if (!selectedRoute) {
      throw new Error(
        `Routing failed: neither selected route "${decision.route}" nor fallback "${fallback}" exist in configured routes`,
      );
    }

    onRoute?.({
      selectedRoute: selectedRoute.name,
      reason: decision.reason,
      context,
      step: context.step,
    });

    return selectedRoute.generate(context);
  };
}
