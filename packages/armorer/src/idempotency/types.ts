/**
 * A cached tool execution result stored in the result cache.
 */
export type CachedToolResult = {
  status?: 'completed';
  result: unknown;
  toolName: string;
  executedAt: number;
  ttl: number;
};

export type StartedToolExecution = {
  status: 'started';
  toolName: string;
  startedAt: number;
  ttl: number;
  /** Unique fencing token for the claimant that started the execution. */
  attemptId?: string;
  /** Lease expiry used to renew an in-flight execution. */
  leaseExpiresAt?: number;
  /** Absolute deadline after which the attempt can no longer be renewed. */
  absoluteDeadline?: number;
};

export type IdempotencyResolutionReceipt = {
  version: 1;
  key: string;
  attemptId: string;
  tenantId: string;
  toolRevision: string;
  decision: 'retry';
  evidence: string;
  authorizedAt: number;
  authorizedBy: string;
  nonce: string;
  authorization: string;
};

export type ToolResultCacheEntry = CachedToolResult | StartedToolExecution;
export type ToolResultCacheClaimResult =
  { outcome: 'claimed' } | { outcome: 'existing'; entry: ToolResultCacheEntry };

/**
 * Cache interface for storing and retrieving idempotent tool results.
 * Backed by a KeyValueStore but exposes a typed API over CachedToolResult.
 */
export type ToolResultCache = {
  /** Retrieve a completed cached result by key. Returns undefined if not found, expired, or incomplete. */
  get(key: string): Promise<CachedToolResult | undefined>;
  /** Retrieve the raw cache state, including started-but-unrecorded executions. */
  getState(key: string): Promise<ToolResultCacheEntry | undefined>;
  /** Store a result with an optional TTL override. */
  set(key: string, result: CachedToolResult, ttl?: number): Promise<void>;
  /**
   * Claim a key before running a side effect. Atomic cache backends should
   * implement this with compare-and-set semantics.
   */
  claimStarted(
    key: string,
    execution: StartedToolExecution,
    ttl?: number,
  ): Promise<ToolResultCacheClaimResult>;
  /** Mark a key as started before running a side effect. */
  /** Renew a started marker only when the fencing token still owns it. */
  renewStarted(
    key: string,
    attemptId: string,
    leaseExpiresAt: number,
    observedAt: number,
  ): Promise<boolean>;
  /** Complete a started marker only when the fencing token still owns it. */
  completeStarted(
    key: string,
    attemptId: string,
    result: CachedToolResult,
    ttl?: number,
    observedAt?: number,
  ): Promise<boolean>;
  /** Atomically replace a known unknown-outcome attempt after authorization. */
  replaceUnknownStarted(
    key: string,
    expectedAttemptId: string,
    execution: StartedToolExecution,
    observedAt: number,
  ): Promise<boolean>;
  /** Remove a started marker only when the fencing token still owns it. */
  deleteStarted(key: string, attemptId: string): Promise<boolean>;
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
  tenantId: string;
  toolRevision?: string;
  ttl?: number;
  onCacheHit?: (key: string, result: CachedToolResult) => void;
  onUnknownOutcome?: (key: string, execution: StartedToolExecution) => void;
};
