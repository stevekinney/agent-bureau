/** Options for controlling jitter behavior. */
export interface JitterOptions {
  /** Whether jitter is enabled. When false, returns the exact delay. */
  enabled?: boolean;
  /** Maximum jitter offset in milliseconds. Defaults to half the delay. */
  maxJitter?: number;
}

/**
 * Adds random jitter to a delay value for retry backoff.
 *
 * Returns a value in `[delay - maxJitter, delay + maxJitter]`, clamped to
 * a minimum of zero. When the delay is zero or jitter is disabled, the
 * original delay is returned unchanged.
 */
export function addJitter(delay: number, options?: JitterOptions): number {
  if (delay === 0) return 0;
  if (options?.enabled === false) return delay;

  const maxJitter = options?.maxJitter ?? delay / 2;
  if (maxJitter === 0) return delay;

  const offset = (Math.random() * 2 - 1) * maxJitter;
  return Math.max(0, Math.round(delay + offset));
}
