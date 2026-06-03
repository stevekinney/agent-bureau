/**
 * Cache middleware for LLM generate functions.
 *
 * Wraps a `GenerateFunction` with a caching layer backed by a `TextValueStore`.
 * On cache hit, the stored response is returned without calling the underlying
 * generate function. On miss, the response is computed, stored, and returned.
 */

import type { TextValueStore } from '@lostgradient/weft/storage';

import type { GenerateContext, GenerateFunction } from '../types';
import { conversationHashKey, lastMessageKey } from './cache-keys';
import type { CacheEntry, CacheKeyFunction, CacheOptions } from './types';

/**
 * Resolves the key strategy option into a concrete key function and a label
 * for storage in the cache entry.
 */
function resolveKeyStrategy(strategy: CacheOptions['keyStrategy']): {
  keyFn: CacheKeyFunction;
  label: string;
} {
  if (typeof strategy === 'function') {
    return { keyFn: strategy, label: 'custom' };
  }
  if (strategy === 'last-message') {
    return { keyFn: lastMessageKey, label: 'last-message' };
  }
  return { keyFn: conversationHashKey, label: 'conversation-hash' };
}

/**
 * Evicts the oldest cache entries until the count is within the limit.
 * Returns the number of entries removed so the caller can adjust its counter.
 */
async function evictOldest(
  store: TextValueStore,
  namespace: string,
  maxEntries: number,
): Promise<number> {
  const keys = await store.list(namespace);
  if (keys.length <= maxEntries) return 0;

  // Collect entries with their creation timestamps
  const entries: Array<{ key: string; createdAt: number }> = [];
  for (const key of keys) {
    const raw = await store.get(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CacheEntry;
        entries.push({ key, createdAt: parsed.createdAt });
      } catch {
        // Corrupt entry — remove it
        await store.delete(key);
      }
    }
  }

  // Sort oldest first
  entries.sort((a, b) => a.createdAt - b.createdAt);

  const toRemove = entries.length - maxEntries;
  for (let i = 0; i < toRemove; i++) {
    await store.delete(entries[i]!.key);
  }
  return Math.max(0, toRemove);
}

/**
 * Wraps a `GenerateFunction` with configurable caching backed by a `TextValueStore`.
 *
 * On cache hit the stored response is returned without calling the underlying
 * generate function. On miss, the response is computed, stored, and returned.
 */
export function withCache(generate: GenerateFunction, options: CacheOptions): GenerateFunction {
  const {
    store,
    ttl = 3600,
    keyStrategy,
    namespace = 'llm-cache:',
    invalidateOnToolCalls = false,
    onHit,
    onMiss,
    maxEntries = 1000,
  } = options;

  const { keyFn, label } = resolveKeyStrategy(keyStrategy);

  // Track approximate entry count to avoid O(n) store.list() on every miss.
  // Initialized lazily on first call; incremented on set, decremented on delete/evict.
  let entryCount = -1;
  let countInitialized = false;

  return async (context: GenerateContext) => {
    // Lazily initialize the entry count from the store on first call
    if (!countInitialized) {
      const keys = await store.list(namespace);
      entryCount = keys.length;
      countInitialized = true;
    }
    const rawKey = keyFn(context);
    const key = `${namespace}${rawKey}`;

    // Check for cached entry
    const cached = await store.get(key);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as CacheEntry;

        // TTL check: ttl of 0 means no expiry
        const expired = entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl * 1000;

        if (!expired) {
          // Update hit count
          const updated: CacheEntry = { ...entry, hits: entry.hits + 1 };
          await store.set(key, JSON.stringify(updated));

          onHit?.({ key, age: Date.now() - entry.createdAt });
          return entry.response;
        }

        // Expired — delete the stale entry before falling through to miss
        await store.delete(key);
        entryCount--;
      } catch {
        // Corrupt entry — delete it and fall through to miss
        await store.delete(key);
        entryCount--;
      }
    }

    // Cache miss: call the underlying generate function
    const start = Date.now();
    const response = await generate(context);
    const duration = Date.now() - start;

    // Don't cache if the signal was aborted
    if (context.signal?.aborted) {
      return response;
    }

    // Don't cache responses with tool calls when configured
    if (invalidateOnToolCalls && response.toolCalls.length > 0) {
      onMiss?.({ key, duration });
      return response;
    }

    // Store the entry
    const entry: CacheEntry = {
      response,
      createdAt: Date.now(),
      ttl,
      hits: 0,
      keyStrategy: label,
    };
    await store.set(key, JSON.stringify(entry));
    entryCount++;

    // Only run eviction when the approximate count exceeds the limit
    if (entryCount > maxEntries) {
      const removed = await evictOldest(store, namespace, maxEntries);
      entryCount -= removed;
    }

    onMiss?.({ key, duration });
    return response;
  };
}
