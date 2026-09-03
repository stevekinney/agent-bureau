/**
 * The `RuntimeServices` contract (AB-92's Decision (2026-09-01), AC4) — the
 * single injectable seam for wall time, monotonic time, timers,
 * identifiers, randomness, and deferred-work tracking. Every member is
 * `readonly`; a consumer swaps an entire service (`clock`, `timers`, ...),
 * never mutates one in place.
 *
 * `createDefaultRuntimeServices()` is the only function in this package (or
 * in `@lostgradient/operative`, once the operative run-path migrates onto
 * it) that reaches the real globals (`Date.now`, `performance.now`,
 * `globalThis.setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`,
 * `crypto.randomUUID`, `Math.random`). Everything else composes against the
 * `RuntimeServices` interface, so a test swaps in
 * `createManualRuntimeServices()` (see `manual-runtime-services.ts`)
 * instead of touching a real timer or a real clock.
 */

/** Wall-clock time. Replaces every `Date.now()`/`new Date()` call site. */
export interface RuntimeClock {
  readonly now: () => number;
  readonly nowISO: () => string;
}

/** Monotonic duration measurement. Replaces every `performance.now()` call site. */
export interface RuntimeMonotonic {
  readonly now: () => number;
}

/** Opaque timer handle — never inspected, only round-tripped to `clearTimeout`/`clearInterval`. */
export type RuntimeTimeoutHandle = unknown;

/**
 * Timers. Generalizes the pre-existing `ScheduleTimeout`/`ClearScheduledTimeout`
 * pair in `hooks/composition.ts` and the timer seam in `session-handle.ts`
 * rather than adding a competing one.
 */
export interface RuntimeTimers {
  readonly setTimeout: (callback: () => void, milliseconds?: number) => RuntimeTimeoutHandle;
  readonly clearTimeout: (handle: RuntimeTimeoutHandle) => void;
  readonly setInterval: (callback: () => void, milliseconds?: number) => RuntimeTimeoutHandle;
  readonly clearInterval: (handle: RuntimeTimeoutHandle) => void;
}

/**
 * Stable identifier generation. Replaces every `crypto.randomUUID()` call
 * site. `kind` namespaces the sequence, e.g. `'run'`, `'session'`, `'child'`,
 * `'execution'`.
 */
export interface RuntimeIdentifiers {
  readonly next: (kind: string) => string;
}

/** Deterministic pseudo-randomness. Replaces every `Math.random()` call site. */
export interface RuntimeRandom {
  /** A value in `[0, 1)`, matching `Math.random()`'s own contract. */
  readonly next: () => number;
}

/** One tracked promise's terminal outcome, reported by `RuntimeDeferred.drain()`. */
export interface DeferredDrainReport {
  readonly settled: readonly {
    readonly label: string;
    readonly outcome: 'resolved' | 'rejected';
  }[];
  readonly outstanding: readonly string[];
}

/**
 * Deferred-work drain. Every fire-and-forget promise AB-37 names registers
 * here in addition to its package-local tracking set.
 */
export interface RuntimeDeferred {
  readonly track: (promise: Promise<unknown>, label: string) => void;
  readonly drain: () => Promise<DeferredDrainReport>;
}

/**
 * The injectable runtime-service contract (AB-92 AC4). A production caller
 * that never supplies one gets {@link createDefaultRuntimeServices}'s real-
 * globals implementation; a test composes its own deterministic instance
 * from `@lostgradient/operative/test`'s `createManualRuntimeServices`.
 */
export interface RuntimeServices {
  readonly clock: RuntimeClock;
  readonly monotonic: RuntimeMonotonic;
  readonly timers: RuntimeTimers;
  readonly identifiers: RuntimeIdentifiers;
  readonly random: RuntimeRandom;
  readonly deferred: RuntimeDeferred;
}

interface TrackedDeferred {
  readonly label: string;
  readonly promise: Promise<unknown>;
  outcome: 'resolved' | 'rejected' | undefined;
}

/**
 * `drain()`'s quiescence detector: after each settlement race, it waits this
 * many microtask ticks (plus one real zero-delay macrotask tick) looking for
 * further progress among the still-pending entries before concluding that
 * nothing more is imminent and reporting them `outstanding`. Generous enough
 * to ride out a deeply-chained `async`/`await` sequence, small enough that a
 * genuinely-hung promise (e.g. real, slow I/O) is reported quickly rather
 * than held open indefinitely.
 */
const DRAIN_QUIESCENCE_MICROTASK_TICKS = 25;

/**
 * Creates the real-globals implementation of {@link RuntimeServices}. This is
 * the ONLY function in this package that calls `Date.now`, `new Date`,
 * `performance.now`, `globalThis.setTimeout`, `globalThis.clearTimeout`,
 * `globalThis.setInterval`, `globalThis.clearInterval`, `crypto.randomUUID`,
 * or `Math.random` — every other module composes against the
 * {@link RuntimeServices} interface instead.
 *
 * Each call returns a fresh, independent instance: `identifiers` counters
 * and `deferred` tracking are per-instance state, never shared across
 * instances or processes.
 */
export function createDefaultRuntimeServices(): RuntimeServices {
  const identifierCounters = new Map<string, number>();
  const tracked = new Map<string, TrackedDeferred>();

  const clock: RuntimeClock = {
    now: () => Date.now(),
    nowISO: () => new Date().toISOString(),
  };

  const monotonic: RuntimeMonotonic = {
    now: () => performance.now(),
  };

  const timers: RuntimeTimers = {
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const identifiers: RuntimeIdentifiers = {
    next: (kind) => {
      const next = (identifierCounters.get(kind) ?? 0) + 1;
      identifierCounters.set(kind, next);
      return `${kind}-${next}-${crypto.randomUUID()}`;
    },
  };

  const random: RuntimeRandom = {
    next: () => Math.random(),
  };

  const deferred: RuntimeDeferred = {
    track: (promise, label) => {
      // A fresh unique key per call — the same label may be tracked more
      // than once concurrently (e.g. two fire-and-forget promises from the
      // same call site), and each occurrence must be reported independently.
      const key = `${label}#${crypto.randomUUID()}`;
      const entry: TrackedDeferred = { label, promise, outcome: undefined };
      tracked.set(key, entry);
      // Never lets a rejection become an unhandled rejection: the outcome is
      // recorded here and surfaced only through `drain()`'s report.
      void promise.then(
        () => {
          entry.outcome = 'resolved';
        },
        () => {
          entry.outcome = 'rejected';
        },
      );
    },
    drain: async () => {
      // Snapshot the keys tracked as of this call — a promise tracked DURING
      // the drain (from inside a settling callback) is picked up by the next
      // `drain()` call, not this one, so `drain()` always terminates.
      const keys = [...tracked.keys()];
      const settled: { label: string; outcome: 'resolved' | 'rejected' }[] = [];
      const outstanding: string[] = [];

      // Wait for the snapshot to settle without ever hanging forever on one
      // that never does: each pass races every still-pending entry's own
      // settlement against a bounded quiescence window (microtask ticks plus
      // one real zero-delay macrotask tick). Progress (something settling)
      // starts the next pass; no progress across a full window means nothing
      // more is imminent, and everything still pending is reported
      // `outstanding` rather than awaited indefinitely.
      let pending = keys.filter((key) => tracked.get(key)?.outcome === undefined);
      while (pending.length > 0) {
        const settlementRace = Promise.race(pending.map((key) => tracked.get(key)!.promise));
        const quiescenceWindow = (async () => {
          for (let tick = 0; tick < DRAIN_QUIESCENCE_MICROTASK_TICKS; tick++) {
            await Promise.resolve();
          }
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
        })();
        await Promise.race([
          settlementRace.then(
            () => undefined,
            () => undefined,
          ),
          quiescenceWindow,
        ]);
        const stillPending = pending.filter((key) => tracked.get(key)?.outcome === undefined);
        if (stillPending.length === pending.length) {
          // No candidate settled within the quiescence window — every
          // remaining entry is genuinely outstanding, not merely
          // mid-settlement.
          break;
        }
        pending = stillPending;
      }

      for (const key of keys) {
        const entry = tracked.get(key);
        if (!entry) continue;
        if (entry.outcome === undefined) {
          outstanding.push(entry.label);
        } else {
          settled.push({ label: entry.label, outcome: entry.outcome });
          tracked.delete(key);
        }
      }

      return { settled, outstanding };
    },
  };

  return { clock, monotonic, timers, identifiers, random, deferred };
}
