/**
 * Types for LLM response caching.
 *
 * Defines the public interfaces for cache configuration, entries,
 * events, and metrics tracking.
 */

import type { TextValueStore } from '@lostgradient/weft/storage';

import type { GenerateContext, GenerateResponse } from '../types';

/** Function that derives a cache key from a generate context. */
export type CacheKeyFunction = (context: GenerateContext) => string;

/** Options for configuring the cache middleware. */
export type CacheOptions = {
  /** Storage backend for cached responses. */
  store: TextValueStore;
  /** TTL in seconds. 0 means no expiry. Default: `3600`. */
  ttl?: number;
  /** Strategy for generating cache keys. Default: `'conversation-hash'`. */
  keyStrategy?: 'conversation-hash' | 'last-message' | CacheKeyFunction;
  /** Namespace prefix for cache keys. Default: `'llm-cache:'`. */
  namespace?: string;
  /** When true, responses with tool calls are not cached. Default: `false`. */
  invalidateOnToolCalls?: boolean;
  /** Called on cache hit. */
  onHit?: (event: CacheHitEvent) => void;
  /** Called on cache miss. */
  onMiss?: (event: CacheMissEvent) => void;
  /** Maximum number of entries. When exceeded, oldest entries are evicted. Default: `1000`. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
};

/** Event dispatched when a cached response is found and returned. */
export type CacheHitEvent = {
  key: string;
  /** Milliseconds since the entry was cached. */
  age: number;
};

/** Event dispatched when no cached response is found. */
export type CacheMissEvent = {
  key: string;
  /** Milliseconds the generate call took. */
  duration: number;
};

/** A serialized cache entry stored in the key-value store. */
export type CacheEntry = {
  response: GenerateResponse;
  /** Timestamp in milliseconds when the entry was created. */
  createdAt: number;
  /** TTL in seconds. */
  ttl: number;
  /** Number of times this entry has been served from cache. */
  hits: number;
  /** Name of the key strategy used to produce this entry's key. */
  keyStrategy: string;
};

/** Accumulated cache performance metrics. */
export type CacheMetrics = {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly totalSavedTokens: number;
  readonly estimatedSavedCost: number;
  /** Reset all counters to zero. */
  reset(): void;
};
