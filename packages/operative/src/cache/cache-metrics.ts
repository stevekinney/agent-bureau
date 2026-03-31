/**
 * Cache metrics wrapper for monitoring cache performance.
 *
 * Wraps `withCache` and intercepts hit/miss callbacks to accumulate
 * metrics like hit rate, saved tokens, and estimated cost savings.
 */

import { estimateCost } from '../cost-estimation';
import type { GenerateContext, GenerateFunction } from '../types';
import { conversationHashKey } from './cache-keys';
import type { CacheKeyFunction, CacheMetrics, CacheOptions } from './types';
import { withCache } from './with-cache';

/** Options for `withCacheMetrics`, extending `CacheOptions` with an optional model for cost estimation. */
export type CacheMetricsOptions = CacheOptions & {
  /** Model identifier used for cost estimation. When omitted, `estimatedSavedCost` stays at 0. */
  model?: string;
};

/** Resolves the key strategy option to a concrete key function. */
function resolveKeyStrategy(strategy: CacheOptions['keyStrategy']): CacheKeyFunction {
  if (typeof strategy === 'function') return strategy;
  // 'last-message' and 'conversation-hash' both use conversationHashKey as a safe default
  // since we only need key identity (same key = same call), not the exact strategy
  return conversationHashKey;
}

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

  // Track which cache keys had hits. When onHit fires, we record the key.
  // After the await resolves, we check if this call's key is in the set.
  // Keys are unique per-context, so concurrent calls with different contexts
  // won't interfere with each other.
  const pendingHitKeys = new Set<string>();
  const keyFn = resolveKeyStrategy(options.keyStrategy);

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
  const trackedGenerate: GenerateFunction = async (context: GenerateContext) => {
    const response = await cachedGenerate(context);
    const myKey = `${options.namespace ?? 'llm-cache:'}${keyFn(context)}`;
    const wasHit = pendingHitKeys.delete(myKey);

    if (wasHit && response.usage) {
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
