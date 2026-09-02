import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../backend-descriptor-attachment.ts';
import type { BackendDescriptor } from '../model-catalog.ts';
import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import type { RoutingDecision, RoutingOptions } from './types.ts';

/** `(provider, endpoint, model)` as a collision-safe map key. */
function tripleKey(descriptor: BackendDescriptor): string {
  return JSON.stringify([descriptor.provider, descriptor.endpoint, descriptor.model]);
}

/**
 * Total order over two descriptors sharing the same `(provider, endpoint,
 * model)` triple — content-only, so which one `unionDescriptors` keeps never
 * depends on route array order. Two routes can legitimately attach different
 * descriptor instances for the identical triple (e.g. one built at a
 * different moment, so only `freshness` differs; or one OpenAI route
 * constructed with a proxying `baseURL` and one without, so
 * `endpointAmbiguous` and every derived capability flag differ). An
 * `endpointAmbiguous` descriptor sorts first: reporting the more
 * conservative (capability-flags-false) reading is safer than reporting the
 * official endpoint's capabilities for what might be a proxy. When every
 * OTHER field is identical and only `freshness` differs, `freshness` itself
 * (lexicographically — both are ISO 8601 UTC timestamps, so this is also
 * chronological) becomes the final tiebreak, rather than defaulting to
 * "whichever was inserted first": comparing content with freshness excluded
 * and then falling through to "keep the existing entry" on a tie would make
 * the winner depend on route array order in exactly the one case (identical
 * content, different construction time) this function exists to make
 * order-independent.
 */
function conservativeOrder(a: BackendDescriptor, b: BackendDescriptor): number {
  const aAmbiguous = a.endpointAmbiguous === true;
  const bAmbiguous = b.endpointAmbiguous === true;
  if (aAmbiguous !== bAmbiguous) return aAmbiguous ? -1 : 1;
  const { freshness: aFreshness, ...aRest } = a;
  const { freshness: bFreshness, ...bRest } = b;
  const aSerialized = JSON.stringify(aRest);
  const bSerialized = JSON.stringify(bRest);
  if (aSerialized !== bSerialized) return aSerialized < bSerialized ? -1 : 1;
  return aFreshness < bFreshness ? -1 : aFreshness > bFreshness ? 1 : 0;
}

/**
 * The union of every configured route's attached `BackendDescriptor`(s),
 * deduplicated by `(provider, endpoint, model)` and ordered by that triple
 * lexicographically (AB-64 AC2, AB-245) — so the returned `GenerateFunction`'s
 * attached descriptors are deterministic regardless of route declaration
 * order or which descriptors are shared across routes. A collision (two
 * routes' descriptors sharing the same triple but disagreeing on content) is
 * resolved by `conservativeOrder`, not by insertion order, so the result is
 * identical no matter which route happened to be declared first.
 *
 * Takes the caller's already-deduplicated `routeMap` (last-write-wins by
 * name, matching `createRoutingGenerate`'s own dispatch), not the raw
 * `routes` array: two routes sharing a name are never both reachable —
 * `routeMap.get(name)` only ever returns the last one — so a shadowed
 * earlier route's descriptors must not appear in the union either. Unioning
 * over the raw array would advertise a backend dispatch can never select.
 */
function unionDescriptors(
  routeMap: ReadonlyMap<string, RoutingOptions['routes'][number]>,
): readonly BackendDescriptor[] {
  const byKey = new Map<string, BackendDescriptor>();
  for (const route of routeMap.values()) {
    for (const descriptor of readBackendDescriptors(route.generate)) {
      const key = tripleKey(descriptor);
      const existing = byKey.get(key);
      if (!existing || conservativeOrder(descriptor, existing) < 0) {
        byKey.set(key, descriptor);
      }
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, descriptor]) => descriptor);
}

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
  const { strategy, onRoute, fallback } = options;
  // Snapshot each route object at construction time — copying `name`/
  // `generate`/`costPerMillionTokens` onto a fresh object — rather than
  // reusing `options.routes`'s own objects. Without this, a caller mutating
  // a route in place after construction (e.g. reassigning
  // `options.routes[0].generate`) would make dispatch (which reads through
  // `routeMap`, which references those same objects) silently diverge from
  // the descriptor union already computed below from the ORIGINAL
  // `generate`, advertising a backend the agent no longer actually invokes.
  const routes = options.routes.map((route) => ({ ...route }));
  const routeMap = new Map(routes.map((r) => [r.name, r]));

  const generate: GenerateFunction = async (
    context: GenerateContext,
  ): Promise<GenerateResponse> => {
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

  // AB-64 AC2/AB-245: the union of every REACHABLE route's attached
  // descriptors, deduplicated and lexicographically ordered — see
  // `unionDescriptors`. `routeMap`, not `routes`, so a shadowed
  // duplicate-name route contributes nothing.
  return withBackendDescriptors(generate, unionDescriptors(routeMap));
}
