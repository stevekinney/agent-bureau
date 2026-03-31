/**
 * Cache metrics wrapper for monitoring cache performance.
 *
 * Wraps `withCache` and intercepts hit/miss callbacks to accumulate
 * metrics like hit rate, saved tokens, and estimated cost savings.
 */

import { estimateCost } from '../cost-estimation';
import type { GenerateFunction } from '../types';
import { conversationHashKey, lastMessageKey } from './cache-keys';
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

  // Track per-call hits using cache keys. The onHit callback records the key
  // that was hit, and after the await resolves the caller checks whether the
  // key for its context was recorded — immune to concurrent calls that would
  // otherwise cause misattribution via shared counter comparison.
  const pendingHitKeys = new Set<string>();

  const cachedGenerate = withCache(generate, {
    ...rest,
    onHit: (event) => {
      hits++;
      pendingHitKeys.add(event.key);
      onHit?.(event);
    },
    onMiss: (event) => {
      misses++;
      onMiss?.(event);
    },
  });

  // Wrap to intercept responses for token/cost tracking on hits
  const trackedGenerate: GenerateFunction = async (context) => {
    const response = await cachedGenerate(context);

    // Build the same key that withCache would have produced for this context,
    // then check whether it appeared in the hit set during this call.
    const rawKey = rest.keyStrategy
      ? typeof rest.keyStrategy === 'function'
        ? rest.keyStrategy(context)
        : rest.keyStrategy === 'last-message'
          ? lastMessageKey(context)
          : conversationHashKey(context)
      : conversationHashKey(context);
    const fullKey = `${rest.namespace ?? 'llm-cache:'}${rawKey}`;

    if (pendingHitKeys.has(fullKey)) {
      pendingHitKeys.delete(fullKey);

      if (response.usage) {
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
