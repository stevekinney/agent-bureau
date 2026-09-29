import type { RuntimeTimers } from '@lostgradient/lifecycle';

import { defaultConversationTimers } from './environment';

/** Withdraws one queued task. Calling it after the task ran, or twice, does nothing. */
export type CompactionScheduleCancel = () => void;

/**
 * Decides *when* a queued background compaction runs, never *whether* it
 * may publish. Publication is decided only by `Conversation.compact()`'s
 * compare-and-swap on the controller revision, so an adapter that fires
 * late, early, or twice cannot make a stale candidate commit.
 */
export interface CompactionScheduleAdapter {
  /** Queues `task` to run once, later than now. */
  readonly schedule: (task: () => void) => CompactionScheduleCancel;
}

export interface TimerCompactionScheduleOptions {
  /** Timers to queue through. Defaults to the real-globals runtime timers. */
  readonly timers?: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'> | undefined;
  /** Delay before the task runs. Default: `0`, the next macrotask. */
  readonly delayMs?: number | undefined;
}

/**
 * The portable default adapter: a timer, which Bun, Node, and browsers all
 * provide. The task always runs on a later macrotask, never synchronously
 * inside the call that requested it.
 */
export function createTimerCompactionSchedule(
  options: TimerCompactionScheduleOptions = {},
): CompactionScheduleAdapter {
  const timers = options.timers ?? defaultConversationTimers;
  const delayMs = options.delayMs ?? 0;
  return {
    schedule(task) {
      const handle = timers.setTimeout(task, delayMs);
      return () => timers.clearTimeout(handle);
    },
  };
}

/**
 * The slice of a browser global that idle scheduling reads. Declared
 * structurally so the adapter compiles and runs on hosts without the DOM.
 */
export interface IdleCallbackHost {
  readonly requestIdleCallback?:
    ((callback: () => void, options?: { timeout?: number }) => number) | undefined;
  readonly cancelIdleCallback?: ((handle: number) => void) | undefined;
}

export interface IdleCompactionScheduleOptions {
  /**
   * Longest the host may hold the task waiting for idle time before running
   * it anyway, passed as `requestIdleCallback`'s `timeout`. This is the
   * starvation bound: a page that is never idle still compacts. Default:
   * `1000` milliseconds.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Used when the host has no `requestIdleCallback`/`cancelIdleCallback`
   * pair. Default: {@link createTimerCompactionSchedule}.
   */
  readonly fallback?: CompactionScheduleAdapter | undefined;
  /** Where to read the idle-callback pair from. Default: `globalThis`. */
  readonly host?: IdleCallbackHost | undefined;
}

const DEFAULT_IDLE_TIMEOUT_MS = 1000;

/**
 * The optional browser adapter: runs the task in idle time through
 * `requestIdleCallback`, bounded by a starvation `timeout`. On a host
 * without the idle-callback pair (Bun and Node, today) it uses `fallback`,
 * so the same configuration works everywhere.
 */
export function createIdleCompactionSchedule(
  options: IdleCompactionScheduleOptions = {},
): CompactionScheduleAdapter {
  const host: IdleCallbackHost = options.host ?? globalThis;
  const requestIdle = host.requestIdleCallback;
  const cancelIdle = host.cancelIdleCallback;
  if (typeof requestIdle !== 'function' || typeof cancelIdle !== 'function') {
    return options.fallback ?? createTimerCompactionSchedule();
  }
  const timeout = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  return {
    schedule(task) {
      // Invoked with `host` as `this`: a browser's idle-callback functions
      // throw "Illegal invocation" when detached from `window`.
      const handle = requestIdle.call(host, () => task(), { timeout });
      return () => cancelIdle.call(host, handle);
    },
  };
}
