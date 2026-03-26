import type { RunOptions, RunResult } from '../types';
import type { Scheduler } from './create-scheduler';
import { sleep } from './sleep';
import type { SchedulerPriority, SchedulerTask } from './types';

/**
 * Options for creating a heartbeat instance.
 */
export interface CreateHeartbeatOptions {
  /** The scheduler to submit heartbeat tasks to. */
  scheduler: Scheduler;
  /** Interval between heartbeats in milliseconds. Default: 60000 (1 minute). */
  interval?: number;
  /** Factory that creates the RunOptions for each heartbeat tick. */
  createHeartbeatRun: () => RunOptions | Promise<RunOptions>;
  /** Priority for heartbeat tasks. Default: 'scheduled'. */
  priority?: SchedulerPriority;
  /** Whether to run immediately on start, or wait for the first interval. Default: false. */
  runImmediately?: boolean;
  /** AbortSignal to stop the heartbeat. */
  signal?: AbortSignal;
  /** Maximum consecutive heartbeat failures before stopping. Default: 5. */
  maxConsecutiveFailures?: number;
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
  /** Stop the heartbeat loop. */
  stop(): void;
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
    onTick,
    onFailure,
  } = options;

  let running = false;
  let tickCounter = 0;
  let failures = 0;
  let sleepResolver: (() => void) | undefined;

  /** Sleep that can be interrupted by stop(). Resolves immediately if stop() is called. */
  async function cancellableSleep(milliseconds: number): Promise<void> {
    await Promise.race([
      sleep(milliseconds),
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

  async function tick(): Promise<RunResult | null> {
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
        void onTick?.(null);
        return null;
      }

      if (result.finishReason === 'error') {
        // The run completed with an error — treat as a failure
        failures++;
        if (failures >= maxConsecutiveFailures) {
          stop();
          onFailure?.(result.error ?? new Error('heartbeat tick failed'));
        }
        void onTick?.(result);
        return result;
      }

      // Success — reset failure counter
      failures = 0;
      void onTick?.(result);
      return result;
    } catch (error) {
      failures++;
      if (failures >= maxConsecutiveFailures) {
        stop();
        onFailure?.(error);
      }
      return null;
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

  function stop(): void {
    running = false;
    wakeSleep();
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
