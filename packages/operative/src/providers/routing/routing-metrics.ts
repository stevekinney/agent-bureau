import { createDefaultRuntimeServices } from 'lifecycle';

import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../backend-descriptor-attachment.ts';
import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import { createRoutingGenerate } from './create-routing-generate.ts';
import type { RoutingMetrics, RoutingMetricsResult, RoutingOptions } from './types.ts';

/**
 * Wraps a routing generate function with metrics tracking.
 *
 * Intercepts each generate call to record:
 * - **routeCounts**: how many times each route was selected (successful calls only)
 * - **routeCosts**: accumulated token costs per route (using `costPerMillionTokens`)
 * - **routeLatencies**: duration in ms for each call per route (recorded even on failure)
 *
 * Returns both the wrapped generate function and a metrics handle with a `reset()` method.
 */
export function withRoutingMetrics(options: RoutingOptions): RoutingMetricsResult {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const routeCounts = new Map<string, number>();
  const routeCosts = new Map<string, number>();
  const routeLatencies = new Map<string, number[]>();

  const costLookup = new Map(
    options.routes
      .filter((r) => r.costPerMillionTokens !== undefined)
      .map((r) => [r.name, r.costPerMillionTokens!]),
  );

  // Per-call route capture using a WeakMap keyed by context object.
  // Each concurrent call writes to its own context key, avoiding shared mutable state.
  const routeByContext = new WeakMap<GenerateContext, string>();

  const innerGenerate = createRoutingGenerate({
    ...options,
    onRoute: (event) => {
      routeByContext.set(event.context, event.selectedRoute);
      options.onRoute?.(event);
    },
  });

  const wrappedGenerate: GenerateFunction = async (
    context: GenerateContext,
  ): Promise<GenerateResponse> => {
    const start = runtime.monotonic.now();

    try {
      const response = await innerGenerate(context);
      const elapsed = runtime.monotonic.now() - start;

      const route = routeByContext.get(context) ?? '';

      // Record count
      routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);

      // Record cost
      const totalTokens = response.usage?.total ?? 0;
      const costPerMillion = costLookup.get(route) ?? 0;
      const cost = (totalTokens * costPerMillion) / 1_000_000;
      routeCosts.set(route, (routeCosts.get(route) ?? 0) + cost);

      // Record latency
      const latencies = routeLatencies.get(route) ?? [];
      latencies.push(elapsed);
      routeLatencies.set(route, latencies);

      return response;
    } catch (error) {
      const elapsed = runtime.monotonic.now() - start;

      // Record latency even on failure
      const failedRoute = routeByContext.get(context);
      if (failedRoute) {
        const latencies = routeLatencies.get(failedRoute) ?? [];
        latencies.push(elapsed);
        routeLatencies.set(failedRoute, latencies);
      }

      throw error;
    }
  };

  const metrics: RoutingMetrics = {
    routeCounts,
    routeCosts,
    routeLatencies,
    reset() {
      routeCounts.clear();
      routeCosts.clear();
      routeLatencies.clear();
    },
  };

  // Propagates innerGenerate's attached descriptors (AB-64, AB-245) — the
  // routing union createRoutingGenerate already computed — onto the
  // metrics-tracking wrapper, so wrapping with withRoutingMetrics doesn't
  // silently downgrade the reported generation profile to 'opaque'.
  const generate = withBackendDescriptors(wrappedGenerate, readBackendDescriptors(innerGenerate));

  return { generate, metrics };
}
