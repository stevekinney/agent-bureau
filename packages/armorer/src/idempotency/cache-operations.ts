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
  return cache.getState(key);
}

export async function claimCacheStarted(
  cache: ToolResultCache,
  key: string,
  execution: StartedToolExecution,
  ttl?: number,
): Promise<ToolResultCacheClaimResult> {
  return cache.claimStarted(key, execution, ttl);
}
