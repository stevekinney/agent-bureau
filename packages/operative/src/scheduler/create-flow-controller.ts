import { createSlidingWindow } from '../backpressure';

/**
 * The descriptor a caller admits through the flow controller. Deliberately
 * generic across both entry points a bureau composes over the scheduler:
 * API-triggered runs (`Bureau.createRun`) carry `source: 'api'` and a
 * `principal`; scheduler-originated runs (`Bureau.submitSchedulerTask` /
 * durable schedule fires) carry `source: 'scheduler'` and no principal.
 */
export interface FlowControlTrigger {
  /** Stable identifier for the run this trigger is admitting. */
  readonly runId: string;
  /** The agent this run dispatches to. Falls back to a house default upstream. */
  readonly agentName: string;
  /** The authenticated principal that created the run, when known (API only). */
  readonly principal?: string;
  /** Where the run originated. */
  readonly source: 'api' | 'scheduler';
  /** The seed user message, available to key functions that need content-based dedupe. */
  readonly message: string;
  /** The session this run is attached to, when known. */
  readonly sessionId?: string;
  /** Caller-supplied metadata carried through from the originating request. */
  readonly metadata?: Record<string, unknown>;
}

/** A function that derives a grouping key from a trigger. */
export type FlowControlKeyFunction = (trigger: FlowControlTrigger) => string;

export interface ConcurrencyPolicy {
  /** Maximum number of runs that may be actively executing at once per key. */
  readonly limit: number;
  /** Groups runs for the cap. Defaults to `trigger.agentName` (per-agent concurrency). */
  readonly key?: FlowControlKeyFunction;
}

export interface RateLimitPolicy {
  /** Maximum number of admissions allowed within `windowMilliseconds` per key. */
  readonly limit: number;
  /** The sliding window size, in milliseconds. */
  readonly windowMilliseconds: number;
  /** Groups runs for the limit. Defaults to `trigger.agentName`. */
  readonly key?: FlowControlKeyFunction;
}

export interface SingletonPolicy {
  /**
   * Derives the dedupe key. Required — unlike concurrency/rate-limit, there
   * is no sane default identity for "this is the same logical trigger as
   * that one" (it depends entirely on what the caller considers a duplicate).
   */
  readonly key: FlowControlKeyFunction;
}

/**
 * A declarative flow-control policy composed over the existing token-bucket /
 * sliding-window backpressure primitives (AB-13). Unlike `BackpressureStrategy`
 * (per-step throttling inside one agent loop), this gates ADMISSION of whole
 * runs before they start — the Inngest `concurrency` / `rateLimit` / `singleton`
 * model applied per agent or per an arbitrary key.
 */
export interface FlowControlPolicy {
  readonly concurrency?: ConcurrencyPolicy;
  readonly rateLimit?: RateLimitPolicy;
  readonly singleton?: SingletonPolicy;
}

/** Why an admission was rejected. */
export type FlowControlRejectionReason = 'concurrency' | 'rate-limit' | 'singleton';

export type FlowControlDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: FlowControlRejectionReason };

/**
 * Runtime handle for enforcing a {@link FlowControlPolicy} across a run's
 * lifecycle: admit → (optionally park/resume any number of times) → settle.
 *
 * Three independent lifetimes are tracked per run, matching the semantics of
 * each primitive:
 *
 * - **Rate limit** — consumed once at admission; never released early, only
 *   recovers as the sliding window ages out.
 * - **Concurrency** — held from admission until the run parks (freed while
 *   parked, so a sleeping durable run does not occupy a slot), reacquired on
 *   resume, and released for good at settle.
 * - **Singleton** — claimed at admission, held ACROSS any park/resume cycles,
 *   and released only when the run finally settles. A duplicate trigger that
 *   arrives while the original is parked still dedupes.
 */
export interface FlowController {
  /**
   * Attempt to admit a trigger. Checks singleton → rate limit → concurrency
   * and commits all matching side effects atomically: if any check fails,
   * none of the side effects from this call are committed (no partial
   * consumption of a rate-limit token when concurrency then rejects).
   */
  admit(trigger: FlowControlTrigger): FlowControlDecision;
  /**
   * Mark `runId`'s run as parked (e.g. suspended on `ctx.waitForSignal` or
   * preempted by the priority scheduler). Frees its concurrency slot without
   * touching its singleton claim. A no-op for a run with no held concurrency
   * slot (unknown runId, or a policy with no `concurrency` configured).
   */
  markParked(runId: string): void;
  /**
   * Mark `runId`'s previously parked run as resumed. Reacquires its
   * concurrency slot unconditionally — a resuming run is not re-admitted
   * against the cap, it is continuing work it was already granted. A no-op
   * for a run that was never parked.
   */
  markResumed(runId: string): void;
  /**
   * Release all per-run state: the concurrency slot (if still held) and the
   * singleton claim (if any). Call exactly once, when the run reaches a
   * terminal state. A no-op for an unknown runId.
   */
  settle(runId: string): void;
}

interface ConcurrencyEntry {
  readonly key: string;
  /** Whether this run currently occupies a counted slot (false while parked). */
  held: boolean;
}

/** A rate limiter keyed by an arbitrary string, backed by `createSlidingWindow` per key. */
function createKeyedRateLimiter(policy: RateLimitPolicy, now: () => number) {
  const limiters = new Map<string, ReturnType<typeof createSlidingWindow>>();

  function limiterFor(key: string): ReturnType<typeof createSlidingWindow> {
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = createSlidingWindow({
        windowSize: policy.windowMilliseconds,
        maximumRequests: policy.limit,
        now,
      });
      limiters.set(key, limiter);
    }
    return limiter;
  }

  return {
    /** True when a slot is available for `key` right now. Does not consume. */
    hasCapacity(key: string): boolean {
      return limiterFor(key).currentDelay === 0;
    },
    /** Records an admission for `key`. */
    consume(key: string): void {
      limiterFor(key).onSuccess();
    },
  };
}

/**
 * Creates a {@link FlowController} enforcing `policy`.
 *
 * @param options.now Injectable clock for deterministic tests. Defaults to `Date.now`.
 */
export function createFlowController(
  policy: FlowControlPolicy,
  options?: { now?: () => number },
): FlowController {
  const now = options?.now ?? Date.now;

  const concurrencyKeyFn = policy.concurrency?.key ?? ((trigger) => trigger.agentName);
  const rateLimitKeyFn = policy.rateLimit?.key ?? ((trigger) => trigger.agentName);

  const concurrencyCounts = new Map<string, number>();
  const concurrencyByRun = new Map<string, ConcurrencyEntry>();
  const singletonHolders = new Map<string, string>(); // singleton key -> runId
  const singletonKeyByRun = new Map<string, string>();

  const rateLimiter = policy.rateLimit ? createKeyedRateLimiter(policy.rateLimit, now) : undefined;

  function concurrencyHasCapacity(key: string): boolean {
    if (!policy.concurrency) return true;
    const count = concurrencyCounts.get(key) ?? 0;
    return count < policy.concurrency.limit;
  }

  function concurrencyAcquire(key: string): void {
    concurrencyCounts.set(key, (concurrencyCounts.get(key) ?? 0) + 1);
  }

  function concurrencyRelease(key: string): void {
    const count = concurrencyCounts.get(key) ?? 0;
    if (count <= 1) {
      concurrencyCounts.delete(key);
    } else {
      concurrencyCounts.set(key, count - 1);
    }
  }

  function admit(trigger: FlowControlTrigger): FlowControlDecision {
    // 1. Singleton — reject if another run already holds this key.
    let singletonKey: string | undefined;
    if (policy.singleton) {
      singletonKey = policy.singleton.key(trigger);
      const holder = singletonHolders.get(singletonKey);
      if (holder !== undefined && holder !== trigger.runId) {
        return { allowed: false, reason: 'singleton' };
      }
    }

    // 2. Rate limit — reject without consuming if no capacity.
    let rateLimitKey: string | undefined;
    if (rateLimiter && policy.rateLimit) {
      rateLimitKey = rateLimitKeyFn(trigger);
      if (!rateLimiter.hasCapacity(rateLimitKey)) {
        return { allowed: false, reason: 'rate-limit' };
      }
    }

    // 3. Concurrency — reject without acquiring if no capacity.
    let concurrencyKey: string | undefined;
    if (policy.concurrency) {
      concurrencyKey = concurrencyKeyFn(trigger);
      if (!concurrencyHasCapacity(concurrencyKey)) {
        return { allowed: false, reason: 'concurrency' };
      }
    }

    // All checks passed — commit every side effect together.
    if (singletonKey !== undefined) {
      singletonHolders.set(singletonKey, trigger.runId);
      singletonKeyByRun.set(trigger.runId, singletonKey);
    }
    if (rateLimiter && rateLimitKey !== undefined) {
      rateLimiter.consume(rateLimitKey);
    }
    if (concurrencyKey !== undefined) {
      concurrencyAcquire(concurrencyKey);
      concurrencyByRun.set(trigger.runId, { key: concurrencyKey, held: true });
    }

    return { allowed: true };
  }

  function markParked(runId: string): void {
    const entry = concurrencyByRun.get(runId);
    if (!entry || !entry.held) return;
    concurrencyRelease(entry.key);
    entry.held = false;
  }

  function markResumed(runId: string): void {
    const entry = concurrencyByRun.get(runId);
    if (!entry || entry.held) return;
    concurrencyAcquire(entry.key);
    entry.held = true;
  }

  function settle(runId: string): void {
    const entry = concurrencyByRun.get(runId);
    if (entry) {
      if (entry.held) {
        concurrencyRelease(entry.key);
      }
      concurrencyByRun.delete(runId);
    }

    const singletonKey = singletonKeyByRun.get(runId);
    if (singletonKey !== undefined) {
      // Only clear the holder if THIS run still owns it (defensive against
      // an out-of-order settle after the key was somehow reclaimed).
      if (singletonHolders.get(singletonKey) === runId) {
        singletonHolders.delete(singletonKey);
      }
      singletonKeyByRun.delete(runId);
    }
  }

  return { admit, markParked, markResumed, settle };
}
