import type {
  DeferredDrainReport,
  RuntimeServices,
  RuntimeTimeoutHandle,
} from './runtime-services';

/**
 * The deterministic {@link RuntimeServices} implementation (AB-92 AC5/AC6).
 * Time only moves when {@link ManualRuntimeServices.advance} or
 * {@link ManualRuntimeServices.setTime} is called; timers, identifiers, and
 * randomness are all driven from explicit, seedable state rather than any
 * real global. No member of this module — including {@link
 * createManualRuntimeServices} itself — reaches a real timer, a real clock,
 * or `Math.random`.
 */
export interface ManualRuntimeServices extends RuntimeServices {
  /**
   * Advances the virtual monotonic clock (and, in lockstep, the virtual
   * wall clock) by `milliseconds`, firing every timer whose deadline falls
   * within the advanced window, in deadline order. Awaits the microtask
   * queue between each fired callback, so a callback that schedules another
   * timer inside the advanced window still fires within this same call. An
   * interval re-arms at its own period inside the window rather than firing
   * once. Never touches a real timer and never resolves on a wall-clock
   * deadline — the returned promise settles once every due timer (including
   * ones scheduled during this call, within the window) has fired.
   */
  advance(milliseconds: number): Promise<void>;
  /**
   * Sets the virtual wall clock to an absolute epoch-millisecond value
   * without firing timers or moving the monotonic clock — the two clocks
   * are independent seams, matching a real system where the wall clock can
   * be adjusted (e.g. NTP) without the monotonic clock jumping.
   */
  setTime(epochMilliseconds: number): void;
  /** Every timer currently armed (not yet fired, not cleared), by deadline. */
  pendingTimers(): readonly { readonly handle: RuntimeTimeoutHandle; readonly dueAt: number }[];
  /** Labels of every `deferred.track()`ed promise that has not yet settled. */
  outstandingDeferred(): readonly string[];
}

export interface CreateManualRuntimeServicesOptions {
  /** The virtual wall clock's starting value, as an ISO-8601 string. Defaults to a fixed epoch. */
  origin?: string;
  /**
   * Reserved for future per-instance identifier disambiguation. AB-252's
   * ratified `identifiers.next(kind)` format (`` `${kind}-${n}` ``, `n` a
   * per-`kind` counter starting at 1) is fully determined by call order
   * alone, so this seed does not currently affect minted identifiers —
   * accepted here only so a caller constructing a
   * `ManualRuntimeServices` doesn't have to omit it conditionally.
   */
  identifierSeed?: string;
  /** Seeds the deterministic pseudo-random generator backing `random.next()`. */
  randomSeed?: string;
}

const DEFAULT_ORIGIN = '2020-01-01T00:00:00.000Z';
const DEFAULT_RANDOM_SEED = 'manual-runtime-services';

/** FNV-1a — a small, dependency-free string hash, used only to seed the PRNG below. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a small, dependency-free deterministic PRNG. Two generators
 * built from the same seed produce the same sequence; different seeds
 * diverge. Never calls `Math.random`.
 */
function createSeededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TimerEntry {
  readonly handle: number;
  dueAt: number;
  readonly callback: () => void;
  readonly periodMilliseconds?: number;
  cleared: boolean;
  fired: boolean;
}

interface TrackedDeferred {
  readonly label: string;
  outcome: 'resolved' | 'rejected' | undefined;
}

/**
 * The quiescence window `deferred.drain()`/`outstandingDeferred()` waits
 * for progress within, purely on the microtask queue (never a real timer) —
 * see {@link createDefaultRuntimeServices}'s identical rationale.
 */
const DRAIN_QUIESCENCE_MICROTASK_TICKS = 25;

/**
 * Creates a fresh, fully independent {@link ManualRuntimeServices} instance.
 * Two instances constructed in the same process share no state: advancing
 * one never fires the other's timers, and their identifier counters and
 * timer/deferred bookkeeping are entirely separate.
 */
export function createManualRuntimeServices(
  options: CreateManualRuntimeServicesOptions = {},
): ManualRuntimeServices {
  const originEpochMilliseconds = options.origin
    ? Date.parse(options.origin)
    : Date.parse(DEFAULT_ORIGIN);

  let monotonicMilliseconds = 0;
  // wallClockNow = wallClockOffsetMilliseconds + monotonicMilliseconds. `setTime` rewrites the
  // offset directly, so the wall clock and monotonic clock stay independently adjustable.
  let wallClockOffsetMilliseconds = originEpochMilliseconds;

  const random = createSeededRandom(options.randomSeed ?? DEFAULT_RANDOM_SEED);

  const identifierCounters = new Map<string, number>();

  let nextTimerHandle = 0;
  const timerEntries = new Map<number, TimerEntry>();

  const tracked = new Map<string, TrackedDeferred>();
  let trackedSequence = 0;

  function scheduleTimer(
    callback: () => void,
    milliseconds: number | undefined,
    periodMilliseconds?: number,
  ): RuntimeTimeoutHandle {
    const handle = nextTimerHandle++;
    timerEntries.set(handle, {
      handle,
      dueAt: monotonicMilliseconds + Math.max(0, milliseconds ?? 0),
      callback,
      periodMilliseconds,
      cleared: false,
      fired: false,
    });
    return handle;
  }

  function clearTimer(handle: RuntimeTimeoutHandle): void {
    if (typeof handle !== 'number') return;
    const entry = timerEntries.get(handle);
    if (entry) entry.cleared = true;
  }

  async function drainQuiescently(): Promise<DeferredDrainReport> {
    const keys = [...tracked.keys()];
    const settled: { label: string; outcome: 'resolved' | 'rejected' }[] = [];
    const outstanding: string[] = [];

    let pending = keys.filter((key) => tracked.get(key)?.outcome === undefined);
    while (pending.length > 0) {
      for (let tick = 0; tick < DRAIN_QUIESCENCE_MICROTASK_TICKS; tick++) {
        await Promise.resolve();
      }
      const stillPending = pending.filter((key) => tracked.get(key)?.outcome === undefined);
      if (stillPending.length === pending.length) break;
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
  }

  const services: ManualRuntimeServices = {
    clock: {
      now: () => wallClockOffsetMilliseconds + monotonicMilliseconds,
      nowISO: () => new Date(wallClockOffsetMilliseconds + monotonicMilliseconds).toISOString(),
    },
    monotonic: {
      now: () => monotonicMilliseconds,
    },
    timers: {
      setTimeout: (callback, milliseconds) => scheduleTimer(callback, milliseconds),
      clearTimeout: (handle) => clearTimer(handle),
      setInterval: (callback, milliseconds) =>
        scheduleTimer(callback, milliseconds, Math.max(0, milliseconds ?? 0)),
      clearInterval: (handle) => clearTimer(handle),
    },
    identifiers: {
      next: (kind) => {
        const next = (identifierCounters.get(kind) ?? 0) + 1;
        identifierCounters.set(kind, next);
        return `${kind}-${next}`;
      },
    },
    random: {
      next: random,
    },
    deferred: {
      track: (promise, label) => {
        const key = `${label}#${trackedSequence++}`;
        const entry: TrackedDeferred = { label, outcome: undefined };
        tracked.set(key, entry);
        void promise.then(
          () => {
            entry.outcome = 'resolved';
          },
          () => {
            entry.outcome = 'rejected';
          },
        );
      },
      drain: drainQuiescently,
    },
    advance: async (milliseconds) => {
      const targetMilliseconds = monotonicMilliseconds + Math.max(0, milliseconds);
      for (;;) {
        let next: TimerEntry | undefined;
        for (const entry of timerEntries.values()) {
          if (entry.cleared || entry.fired) continue;
          if (entry.dueAt > targetMilliseconds) continue;
          if (
            !next ||
            entry.dueAt < next.dueAt ||
            (entry.dueAt === next.dueAt && entry.handle < next.handle)
          ) {
            next = entry;
          }
        }
        if (!next) break;

        monotonicMilliseconds = next.dueAt;
        if (next.periodMilliseconds !== undefined) {
          // An interval re-arms at its own period inside the advanced
          // window rather than firing once.
          next.dueAt = monotonicMilliseconds + Math.max(0, next.periodMilliseconds);
        } else {
          next.fired = true;
        }

        next.callback();
        // Awaits the microtask queue between each callback, so a timer
        // scheduled from inside this callback (within the advanced window)
        // is visible to the next iteration's search above.
        await Promise.resolve();
      }
      monotonicMilliseconds = targetMilliseconds;
    },
    setTime: (epochMilliseconds) => {
      wallClockOffsetMilliseconds = epochMilliseconds - monotonicMilliseconds;
    },
    pendingTimers: () =>
      [...timerEntries.values()]
        .filter((entry) => !entry.cleared && !entry.fired)
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((entry) => ({ handle: entry.handle, dueAt: entry.dueAt })),
    outstandingDeferred: () =>
      [...tracked.values()]
        .filter((entry) => entry.outcome === undefined)
        .map((entry) => entry.label),
  };

  return services;
}
