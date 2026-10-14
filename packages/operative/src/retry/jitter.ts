import type { RuntimeRandom } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

// COR-89 — resolved once, lazily, at module scope, mirroring
// `scheduler/sleep.ts`'s `defaultTimers`. Constructing a whole
// `RuntimeServices` (identifier counters, deferred-work tracking, timers) on
// every uncustomized `addJitter()` call just to read one random number would
// be an avoidable per-call allocation. The real-globals `random` seam is
// stateless, so one shared instance is safe to reuse forever.
let defaultRandom: RuntimeRandom | undefined;
function resolveDefaultRandom(): RuntimeRandom {
  defaultRandom ??= createDefaultRuntimeServices().random;
  return defaultRandom;
}

/** Options for controlling jitter behavior. */
export interface JitterOptions {
  /** Whether jitter is enabled. When false, returns the exact delay. */
  enabled?: boolean | undefined;
  /** Maximum jitter offset in milliseconds. Defaults to half the delay. */
  maxJitter?: number | undefined;
  /**
   * AB-92/AB-252 — the pseudo-random source, matching `Math.random()`'s
   * `[0, 1)` contract. Defaults to one module-scoped, lazily resolved
   * `createDefaultRuntimeServices().random` (the real global, unconfigured,
   * shared across calls rather than constructed per call) — pass
   * `deps.runtime.random.next` (or a `createManualRuntimeServices()`
   * instance's) from a caller that already has a resolved `RuntimeServices`,
   * so this never reaches `Math.random()` directly on that path.
   */
  random?: (() => number) | undefined;
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

  const sample = options?.random?.() ?? resolveDefaultRandom().next();
  const offset = (sample * 2 - 1) * maxJitter;
  return Math.max(0, Math.round(delay + offset));
}
