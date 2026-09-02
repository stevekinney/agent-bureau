import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import type { RoutingDecision, RoutingOptions } from './types.ts';

/**
 * Creates a GenerateFunction that routes each call to a different model
 * based on the provided strategy.
 *
 * The strategy inspects the GenerateContext and selects a route by name.
 * If the selected route doesn't exist, the fallback route is used instead.
 * Context and response pass through unchanged — routing is transparent to
 * the caller and the model.
 *
 * AB-67 steering: when `context.steering.route` is set (the session's
 * currently-desired route, read at this step's `runStep` boundary and
 * carried onto `GenerateContext` untouched by any hook), it is used in
 * place of calling `strategy` at all — a steering override supersedes the
 * strategy's own decision for that call. `strategy` still runs on every
 * call with no steering-desired route, and the missing-route fallback below
 * applies identically whether the route came from steering or the
 * strategy: a `route` override this contract does not itself validate
 * against the deployment's catalog (see AB-65) still resolves safely to
 * `fallback` if it does not name a configured route.
 *
 * **Pattern for a non-routing provider factory (e.g. `createAnthropicProvider`
 * and its siblings in `../anthropic.ts`, `../openai.ts`, `../gemini.ts`) to
 * honor a `model`/`provider`/`effort` steering override:** the factory's
 * returned `GenerateFunction` already receives a fresh `GenerateContext` on
 * every call the same way this one does; it should read
 * `context.steering?.model` / `context.steering?.provider` /
 * `context.steering?.effort` at the top of that per-call closure — never
 * once at construction time — and, when set, substitute it for the
 * provider's construction-time default for that one call, exactly as
 * `GenerateContext.maximumTokens` already overrides a construction-time
 * default per call today. A `provider` override that names a different
 * provider than the one a given factory instance implements is out of that
 * factory's own scope to honor; provider-level steering is expected to be
 * resolved by whichever code selects *which* `GenerateFunction` to call
 * (e.g. `createRoutingGenerate` here, generalized to a `provider` axis, or
 * an equivalent dispatcher) before the call reaches an individual factory.
 * `policyRef` resolution and override-against-catalog validation are AB-66/
 * AB-65's territory, not this pattern's.
 */
export function createRoutingGenerate(options: RoutingOptions): GenerateFunction {
  const { routes, strategy, onRoute, fallback } = options;
  const routeMap = new Map(routes.map((r) => [r.name, r]));

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    // `!== undefined`, not truthy: a validated route name is an unrestricted
    // string, so a catalog entry named `''` is a real, distinguishable route
    // — a truthiness check would silently ignore a steering override for it
    // and fall through to the strategy instead.
    const steeringRoute = context.steering?.route;
    const decision: RoutingDecision =
      steeringRoute !== undefined
        ? { route: steeringRoute, reason: 'steering override (AB-67)' }
        : strategy(context, routes);
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
