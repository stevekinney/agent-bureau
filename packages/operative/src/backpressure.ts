/**
 * Backpressure signal returned by a strategy before each step.
 */
export interface BackpressureSignal {
  delay: number;
}

/**
 * A strategy for applying backpressure to the agent loop.
 */
export interface BackpressureStrategy {
  beforeStep(): BackpressureSignal;
  onSuccess(): void;
  onError(error: unknown): void;
  readonly currentDelay: number;
  readonly isActive: boolean;
}

/**
 * Options for the adaptive exponential backoff strategy.
 */
export interface AdaptiveBackoffOptions {
  /** Initial delay in milliseconds after the first error. Defaults to 1000. */
  initialDelay?: number;
  /** Maximum delay in milliseconds. Defaults to 60000. */
  maximumDelay?: number;
  /** Multiplier applied to the delay on each consecutive error. Defaults to 2. */
  multiplier?: number;
  /** Number of consecutive successes required to reset the delay to 0. Defaults to 1. */
  resetAfterSuccesses?: number;
}

/**
 * Creates an adaptive exponential backoff strategy.
 *
 * Starts with 0 delay. On error, the delay becomes
 * `max(initialDelay, currentDelay * multiplier)`, capped at `maximumDelay`.
 * After `resetAfterSuccesses` consecutive successes the delay resets to 0.
 */
export function createAdaptiveBackoff(options?: AdaptiveBackoffOptions): BackpressureStrategy {
  const initialDelay = options?.initialDelay ?? 1000;
  const maximumDelay = options?.maximumDelay ?? 60000;
  const multiplier = options?.multiplier ?? 2;
  const resetAfterSuccesses = options?.resetAfterSuccesses ?? 1;

  let delay = 0;
  let consecutiveSuccesses = 0;

  return {
    beforeStep(): BackpressureSignal {
      return { delay };
    },
    onSuccess(): void {
      consecutiveSuccesses++;
      if (consecutiveSuccesses >= resetAfterSuccesses) {
        delay = 0;
        consecutiveSuccesses = 0;
      }
    },
    onError(): void {
      consecutiveSuccesses = 0;
      delay = Math.min(Math.max(initialDelay, delay * multiplier), maximumDelay);
    },
    get currentDelay(): number {
      return delay;
    },
    get isActive(): boolean {
      return delay > 0;
    },
  };
}

/**
 * Options for the token bucket strategy.
 */
export interface TokenBucketOptions {
  /** Number of tokens added per interval. */
  tokensPerInterval: number;
  /** Interval in milliseconds between token replenishments. */
  interval: number;
  /** Maximum number of tokens the bucket can hold. Defaults to `tokensPerInterval`. */
  maximumTokens?: number;
}

/**
 * Creates a token bucket rate limiting strategy.
 *
 * The bucket starts full at `maximumTokens`. Tokens are replenished at
 * `tokensPerInterval` per `interval` ms. Each step consumes one token.
 * When no tokens are available, `beforeStep()` returns the time until
 * the next token becomes available.
 */
export function createTokenBucket(options: TokenBucketOptions): BackpressureStrategy {
  const { tokensPerInterval, interval } = options;
  const maximumTokens = options.maximumTokens ?? tokensPerInterval;

  let tokens = maximumTokens;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const newTokens = Math.floor(elapsed / interval) * tokensPerInterval;
    if (newTokens > 0) {
      tokens = Math.min(maximumTokens, tokens + newTokens);
      lastRefill = lastRefill + Math.floor(elapsed / interval) * interval;
    }
  }

  function consume(): void {
    refill();
    if (tokens > 0) {
      tokens--;
    }
  }

  return {
    beforeStep(): BackpressureSignal {
      refill();
      if (tokens > 0) {
        return { delay: 0 };
      }
      const elapsed = Date.now() - lastRefill;
      const timeUntilNextToken = interval - elapsed;
      return { delay: Math.max(0, timeUntilNextToken) };
    },
    onSuccess(): void {
      consume();
    },
    onError(): void {
      consume();
    },
    get currentDelay(): number {
      refill();
      if (tokens > 0) return 0;
      const elapsed = Date.now() - lastRefill;
      return Math.max(0, interval - elapsed);
    },
    get isActive(): boolean {
      refill();
      return tokens <= 0;
    },
  };
}

/**
 * Options for the sliding window strategy.
 */
export interface SlidingWindowOptions {
  /** Size of the sliding window in milliseconds. */
  windowSize: number;
  /** Maximum number of requests allowed within the window. */
  maximumRequests: number;
}

/**
 * Creates a sliding window rate limiting strategy.
 *
 * Tracks timestamps of recent calls. If the number of calls within the
 * last `windowSize` ms reaches `maximumRequests`, `beforeStep()` returns
 * the delay until the oldest call slides out of the window.
 */
export function createSlidingWindow(options: SlidingWindowOptions): BackpressureStrategy {
  const { windowSize, maximumRequests } = options;
  const timestamps: number[] = [];

  function pruneExpired(): void {
    const cutoff = Date.now() - windowSize;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
  }

  function computeDelay(): number {
    pruneExpired();
    if (timestamps.length < maximumRequests) {
      return 0;
    }
    const oldest = timestamps[0]!;
    return Math.max(0, oldest + windowSize - Date.now());
  }

  return {
    beforeStep(): BackpressureSignal {
      return { delay: computeDelay() };
    },
    onSuccess(): void {
      pruneExpired();
      timestamps.push(Date.now());
    },
    onError(): void {
      pruneExpired();
      timestamps.push(Date.now());
    },
    get currentDelay(): number {
      return computeDelay();
    },
    get isActive(): boolean {
      return computeDelay() > 0;
    },
  };
}
