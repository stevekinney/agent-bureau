import type { RunResult } from '../types';
import type { Scheduler } from './create-scheduler';
import { sleep } from './sleep';
import type { SchedulerPriority, SchedulerRunOptions, SchedulerTask } from './types';

/**
 * Options for creating a heartbeat instance.
 */
export interface CreateHeartbeatOptions {
  /** The scheduler to submit heartbeat tasks to. */
  scheduler: Scheduler;
  /** Interval between heartbeats in milliseconds. Default: 60000 (1 minute). */
  interval?: number;
  /**
   * Factory that creates the run options for each heartbeat tick.
   * `SchedulerRunOptions`, not `RunOptions` (AB-236) — this factory's
   * return value is forwarded straight into `SchedulerTask.createRun`, and
   * `SchedulerRunOptions` omits `runId` because the scheduler always
   * derives and injects one at dispatch (see its doc comment); a
   * steering-enabled heartbeat should not need to invent a throwaway
   * `runId` the scheduler discards anyway.
   */
  createHeartbeatRun: () => SchedulerRunOptions | Promise<SchedulerRunOptions>;
  /** Priority for heartbeat tasks. Default: 'scheduled'. */
  priority?: SchedulerPriority;
  /** Whether to run immediately on start, or wait for the first interval. Default: false. */
  runImmediately?: boolean;
  /** AbortSignal to stop the heartbeat. */
  signal?: AbortSignal;
  /** Maximum consecutive heartbeat failures before stopping. Default: 5. */
  maxConsecutiveFailures?: number;
  /** Injectable sleep primitive used by the heartbeat loop. Defaults to the scheduler sleep utility. */
  sleepFunction?: (milliseconds: number) => Promise<void>;
  /** Callback when a heartbeat tick completes (including preempted ticks with null result). */
  onTick?: (result: RunResult | null) => void | Promise<void>;
  /** Callback when the heartbeat stops due to max failures. */
  onFailure?: (error: unknown) => void;
}

/**
 * A heartbeat that periodically submits tasks to the scheduler.
 */
export interface Heartbeat {
  /** Start the heartbeat loop. */
  start(): void;
  /** Stop the heartbeat loop. Resolves once the in-flight `tick()` (and its
   *  `onTick` callback promise) settles. A no-op that resolves promptly when
   *  already stopped. */
  stop(): Promise<void>;
  /** Force an immediate heartbeat tick. */
  tick(): Promise<RunResult | null>;
  /** Whether the heartbeat loop is currently running. */
  readonly isRunning: boolean;
  /** Number of ticks that have fired. */
  readonly tickCount: number;
  /** Current count of consecutive failures. */
  readonly consecutiveFailures: number;
}

/**
 * Creates a heartbeat that periodically submits tasks to the scheduler.
 * Uses a sleep-loop (not setInterval) to prevent tick stacking.
 */
export function createHeartbeat(options: CreateHeartbeatOptions): Heartbeat {
  let heartbeatIdCounter = 0;
  const {
    scheduler,
    interval = 60_000,
    createHeartbeatRun,
    priority = 'scheduled',
    runImmediately = false,
    signal,
    maxConsecutiveFailures = 5,
    sleepFunction = sleep,
    onTick,
    onFailure,
  } = options;

  let running = false;
  let tickCounter = 0;
  let failures = 0;
  let sleepResolver: (() => void) | undefined;
  // Every currently in-flight `tick()` call (normally just one, since `loop()`
  // awaits ticks sequentially, but `tick()` is also public and can be invoked
  // directly). `stop()` awaits this set (AB-208) so it does not resolve while a
  // tick — and its `onTick` callback — is still running.
  const inFlightTicks = new Set<Promise<RunResult | null>>();

  /** Sleep that can be interrupted by stop(). Resolves immediately if stop() is called. */
  async function cancellableSleep(milliseconds: number): Promise<void> {
    await Promise.race([
      sleepFunction(milliseconds),
      new Promise<void>((resolve) => {
        sleepResolver = resolve;
      }),
    ]);
    sleepResolver = undefined;
  }

  /** Wake the loop from a cancellableSleep call. */
  function wakeSleep(): void {
    if (sleepResolver) {
      const resolver = sleepResolver;
      sleepResolver = undefined;
      resolver();
    }
  }

  /** Await the `onTick` callback, tracked so `stop()` can await it via the
   *  in-flight tick promise (AB-208) rather than firing it with `void`. A
   *  rejection is swallowed here: a callback failure is the callback's own
   *  concern, distinct from a heartbeat tick failure, and must not become an
   *  unhandled rejection now that it is awaited instead of fire-and-forget. */
  async function fireOnTick(result: RunResult | null): Promise<void> {
    try {
      await onTick?.(result);
    } catch {
      // Swallowed — see doc comment above.
    }
  }

  async function performTick(): Promise<RunResult | null> {
    tickCounter++;
    const taskId = `heartbeat-${++heartbeatIdCounter}-${Date.now().toString(36)}`;

    const task: SchedulerTask = {
      id: taskId,
      priority,
      createRun: createHeartbeatRun,
      requeue: false,
    };

    try {
      const result = await scheduler.submit(task);

      if (result === null) {
        // Preempted — not a failure, not a success. Don't touch consecutiveFailures.
        await fireOnTick(null);
        return null;
      }

      if (result.finishReason === 'error' || result.finishReason === 'tripwire') {
        // The run completed with an error (or was halted by a guardrail
        // tripwire) — treat as a failure
        failures++;
        if (failures >= maxConsecutiveFailures) {
          // Fire-and-forget: awaiting our own stop() here would deadlock, since
          // stop() awaits this very tick's in-flight promise.
          void stop();
          onFailure?.(result.error ?? new Error('heartbeat tick failed'));
        }
        await fireOnTick(result);
        return result;
      }

      // Success — reset failure counter
      failures = 0;
      await fireOnTick(result);
      return result;
    } catch (error) {
      failures++;
      if (failures >= maxConsecutiveFailures) {
        // See the fire-and-forget note above.
        void stop();
        onFailure?.(error);
      }
      return null;
    }
  }

  async function tick(): Promise<RunResult | null> {
    const tickPromise = performTick();
    inFlightTicks.add(tickPromise);
    try {
      return await tickPromise;
    } finally {
      inFlightTicks.delete(tickPromise);
    }
  }

  async function loop(): Promise<void> {
    if (runImmediately) {
      await tick();
      if (!running || signal?.aborted) return;
    }

    while (running && !signal?.aborted) {
      await cancellableSleep(interval);
      if (!running || signal?.aborted) break;
      await tick();
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    void loop();
  }

  async function stop(): Promise<void> {
    // A no-op when there is nothing to stop and nothing in flight — e.g. a
    // repeated call, or a heartbeat that was never started. Otherwise, even a
    // tick invoked directly (not via the loop) must still be awaited below.
    if (!running && inFlightTicks.size === 0) return;
    running = false;
    wakeSleep();
    // Await the in-flight tick(s) (and their tracked `onTick` promise) so stop()
    // is a real credential-lifetime boundary rather than a best-effort signal
    // (AB-208).
    await Promise.allSettled([...inFlightTicks]);
  }

  return {
    start,
    stop,
    tick,
    get isRunning() {
      return running;
    },
    get tickCount() {
      return tickCounter;
    },
    get consecutiveFailures() {
      return failures;
    },
  };
}
