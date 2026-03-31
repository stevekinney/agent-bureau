/**
 * Cache metrics wrapper for monitoring cache performance.
 *
 * Wraps `withCache` and intercepts hit/miss callbacks to accumulate
 * metrics like hit rate, saved tokens, and estimated cost savings.
 */

import { estimateCost } from '../cost-estimation';
import type { GenerateFunction } from '../types';
import type { CacheMetrics, CacheOptions } from './types';
import { withCache } from './with-cache';

/** Options for `withCacheMetrics`, extending `CacheOptions` with an optional model for cost estimation. */
export type CacheMetricsOptions = CacheOptions & {
  /** Model identifier used for cost estimation. When omitted, `estimatedSavedCost` stays at 0. */
  model?: string;
};

/**
 * Wraps a `GenerateFunction` with caching and accumulates performance metrics.
 *
 * Returns both the cached generate function and a live `CacheMetrics` object
 * whose properties reflect the current state of the cache.
 */
export function withCacheMetrics(
  generate: GenerateFunction,
  options: CacheMetricsOptions,
): { generate: GenerateFunction; metrics: CacheMetrics } {
  const { model, onHit, onMiss, ...rest } = options;

  let hits = 0;
  let misses = 0;
  let totalSavedTokens = 0;
  let estimatedSavedCost = 0;

  const cachedGenerate = withCache(generate, {
    ...rest,
    onHit: (event) => {
      hits++;
      onHit?.(event);
    },
    onMiss: (event) => {
      misses++;
      onMiss?.(event);
    },
  });

  // Wrap to intercept responses for token/cost tracking on hits
  const trackedGenerate: GenerateFunction = async (context) => {
    const hitsBefore = hits;
    const response = await cachedGenerate(context);

    // If a hit occurred during this call, accumulate saved tokens
    if (hits > hitsBefore && response.usage) {
      const saved = response.usage.prompt + response.usage.completion;
      totalSavedTokens += saved;

      if (model) {
        try {
          const cost = estimateCost(response.usage, model);
          estimatedSavedCost += cost.totalCost;
        } catch {
          // Unknown model — skip cost estimation
        }
      }
    }

    return response;
  };

  const metrics: CacheMetrics = {
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get hitRate() {
      const total = hits + misses;
      return total === 0 ? 0 : hits / total;
    },
    get totalSavedTokens() {
      return totalSavedTokens;
    },
    get estimatedSavedCost() {
      return estimatedSavedCost;
    },
    reset() {
      hits = 0;
      misses = 0;
      totalSavedTokens = 0;
      estimatedSavedCost = 0;
    },
  };

  return { generate: trackedGenerate, metrics };
}
