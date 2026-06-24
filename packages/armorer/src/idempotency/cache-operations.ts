import type {
  StartedToolExecution,
  ToolResultCache,
  ToolResultCacheClaimResult,
  ToolResultCacheEntry,
} from './types';

export async function getCacheEntry(
  cache: ToolResultCache,
  key: string,
): Promise<ToolResultCacheEntry | undefined> {
  if (cache.getState) {
    return cache.getState(key);
  }

  return cache.get(key);
}

export async function claimCacheStarted(
  cache: ToolResultCache,
  key: string,
  execution: StartedToolExecution,
  ttl?: number,
): Promise<ToolResultCacheClaimResult> {
  if (cache.claimStarted) {
    return cache.claimStarted(key, execution, ttl);
  }

  const existing = await getCacheEntry(cache, key);
  if (existing) {
    return { outcome: 'existing', entry: existing };
  }

  await cache.markStarted?.(key, execution, ttl);
  return { outcome: 'claimed' };
}
