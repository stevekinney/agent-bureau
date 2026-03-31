/**
 * A cached tool execution result stored in the result cache.
 */
export type CachedToolResult = {
  result: unknown;
  toolName: string;
  executedAt: number;
  ttl: number;
};

/**
 * Cache interface for storing and retrieving idempotent tool results.
 * Backed by a KeyValueStore but exposes a typed API over CachedToolResult.
 */
export type ToolResultCache = {
  /** Retrieve a cached result by key. Returns undefined if not found or expired. */
  get(key: string): Promise<CachedToolResult | undefined>;
  /** Store a result with an optional TTL override. */
  set(key: string, result: CachedToolResult, ttl?: number): Promise<void>;
  /** Remove a specific cached result. */
  delete(key: string): Promise<void>;
  /** Remove all cached results. */
  clear(): Promise<void>;
};

/**
 * Options for wrapping a tool with idempotency behavior.
 */
export type IdempotencyOptions = {
  cache: ToolResultCache;
  ttl?: number;
  onCacheHit?: (key: string, result: CachedToolResult) => void;
};
