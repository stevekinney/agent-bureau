import type { ActiveRun } from '../create-run';
import { createRun } from '../create-run';
import { executeLoop } from '../loop';
import type { GenerateFunction, RunOptions, RunResult, Toolbox } from '../types';
import type { SchedulerEventMap, SchedulerEventType } from './events';
import {
  SchedulerIdleEvent,
  SchedulerStartedEvent,
  SchedulerStoppedEvent,
  TaskCompletedEvent,
  TaskDispatchedEvent,
  TaskFailedEvent,
  TaskPreemptedEvent,
  TaskQueuedEvent,
} from './events';
import { createPriorityQueue } from './priority-queue';
import { sleep } from './sleep';
import type {
  SchedulerPriority,
  SchedulerState,
  SchedulerTask,
  SchedulerTaskSummary,
} from './types';
import { isHigherPriority } from './types';

/**
 * Options for creating a scheduler instance.
 */
export interface CreateSchedulerOptions {
  /** The generate function shared across all runs. */
  generate: GenerateFunction;
  /** Default toolbox (tasks can override via their RunOptions). */
  toolbox: Toolbox;
  /** How long to wait after a run completes before dispatching the next non-immediate task (ms). Default: 1000. */
  idleDelay?: number;
  /** AbortSignal to shut down the entire scheduler. */
  signal?: AbortSignal;
}

/**
 * The scheduler interface returned by createScheduler.
 */
export interface Scheduler {
  /** Submit a task to the scheduler. Resolves when the task completes, or null if permanently preempted. */
  submit(task: SchedulerTask): Promise<RunResult | null>;
  /** Convenience: submit an immediate-priority task. Resolves with the run result. */
  submitImmediate(createRunFactory: () => RunOptions | Promise<RunOptions>): Promise<RunResult>;
  /** Eagerly creates an ActiveRun for immediate-priority tasks. Returns both the
   *  ActiveRun handle (for store registration / event forwarding) and the result promise.
   *  The factory must be synchronous — use submit() for async factories. */
  dispatch(createRunFactory: () => RunOptions): {
    activeRun: ActiveRun;
    result: Promise<RunResult>;
  };
  /** Get the current scheduler state. */
  getState(): SchedulerState;
  /** Start the scheduler loop. */
  start(): void;
  /** Stop the scheduler. Completes active immediate tasks, aborts active background tasks,
   *  discards queued-but-not-started tasks. */
  stop(): Promise<void>;
  /** Add an event listener. */
  addEventListener<K extends SchedulerEventType>(
    type: K,
    listener: (event: SchedulerEventMap[K]) => void,
  ): void;
  /** Remove an event listener. */
  removeEventListener<K extends SchedulerEventType>(
    type: K,
    listener: (event: SchedulerEventMap[K]) => void,
  ): void;
}

interface RunningTask {
  task: SchedulerTask;
  abortController: AbortController;
  result: Promise<RunResult>;
  requeues: number;
}

function taskSummary(task: SchedulerTask): SchedulerTaskSummary {
  return { id: task.id, priority: task.priority, metadata: task.metadata };
}

/**
 * Creates a priority-aware scheduler that dispatches tasks, manages the active run,
 * and handles preemption between operative steps.
 */
export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const { generate, toolbox, idleDelay = 1000, signal: externalSignal } = options;

  let taskIdCounter = 0;

  function generateTaskId(): string {
    return `task-${++taskIdCounter}-${Date.now().toString(36)}`;
  }

  const emitter = new EventTarget();
  const queue = createPriorityQueue<SchedulerTask & { __requeues?: number }>();
  const running = new Map<string, RunningTask>();
  let completedCount = 0;
  let preemptedCount = 0;
  let started = false;
  let stopping = false;
  let loopPromise: Promise<void> | undefined;
  let lastTaskCompletedAt = 0;

  // Resolvers for tasks awaiting completion via submit()
  const taskResolvers = new Map<
    string,
    { resolve: (result: RunResult | null) => void; reject: (error: unknown) => void }
  >();

  function emitEvent(event: Event): void {
    emitter.dispatchEvent(event);
  }

  function getState(): SchedulerState {
    const queued: Record<SchedulerPriority, SchedulerTaskSummary[]> = {
      immediate: [],
      scheduled: [],
      background: [],
      ambient: [],
    };

    for (const task of queue) {
      queued[task.priority].push(taskSummary(task));
    }

    const activeTask = running.size > 0 ? taskSummary([...running.values()][0]!.task) : undefined;

    return {
      activeTask,
      queued,
      completedCount,
      preemptedCount,
      idle: running.size === 0 && queue.size === 0,
    };
  }

  // ── Wake/Sleep Coordination ───────────────────────────────────────

  let wakeResolver: (() => void) | undefined;

  function wakeLoop(): void {
    if (wakeResolver) {
      const resolver = wakeResolver;
      wakeResolver = undefined;
      resolver();
    }
  }

  async function waitForWake(timeoutMs: number): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => {
        wakeResolver = resolve;
      }),
      sleep(timeoutMs),
    ]);
    wakeResolver = undefined;
  }

  // ── Task Submission ───────────────────────────────────────────────

  function submit(task: SchedulerTask): Promise<RunResult | null> {
    if (stopping) {
      return Promise.resolve(null);
    }

    return new Promise<RunResult | null>((resolve, reject) => {
      taskResolvers.set(task.id, { resolve, reject });
      queue.enqueue(task);
      emitEvent(new TaskQueuedEvent(task.id, task.priority, task.metadata));
      wakeLoop();
    });
  }

  function submitImmediate(
    createRunFactory: () => RunOptions | Promise<RunOptions>,
  ): Promise<RunResult> {
    const taskId = generateTaskId();
    const task: SchedulerTask = {
      id: taskId,
      priority: 'immediate',
      createRun: createRunFactory,
      requeue: false,
    };
    return submit(task) as Promise<RunResult>;
  }

  function dispatchMethod(createRunFactory: () => RunOptions): {
    activeRun: ActiveRun;
    result: Promise<RunResult>;
  } {
    const taskId = generateTaskId();
    const runOptions = createRunFactory();

    // Create an AbortController that the scheduler can use to abort the run
    // (e.g., during stop() or preemption). Pass its signal into createRun so
    // that aborting this controller actually stops the underlying run.
    const abortController = new AbortController();
    const combinedSignal = runOptions.signal
      ? AbortSignal.any([runOptions.signal, abortController.signal])
      : abortController.signal;

    const activeRun = createRun({
      ...runOptions,
      generate: runOptions.generate ?? generate,
      toolbox: runOptions.toolbox ?? toolbox,
      signal: combinedSignal,
    });

    // Register in the running map so getState() reflects this task
    const task: SchedulerTask = {
      id: taskId,
      priority: 'immediate',
      createRun: createRunFactory,
      requeue: false,
    };

    const runningTaskEntry: RunningTask = {
      task,
      abortController,
      result: activeRun.result,
      requeues: 0,
    };
    running.set(taskId, runningTaskEntry);

    emitEvent(new TaskDispatchedEvent(taskId, 'immediate'));

    // Clean up when the run completes and wake the scheduler loop so it can
    // dispatch the next queued task without waiting for the idle delay timeout.
    const result = activeRun.result.then(
      (runResult) => {
        running.delete(taskId);
        completedCount++;
        lastTaskCompletedAt = performance.now();
        emitEvent(new TaskCompletedEvent(taskId, runResult));
        wakeLoop();
        return runResult;
      },
      (error) => {
        running.delete(taskId);
        emitEvent(new TaskFailedEvent(taskId, error));
        wakeLoop();
        throw error;
      },
    );

    return { activeRun, result };
  }

  // ── Scheduling Loop ───────────────────────────────────────────────

  async function schedulerLoop(): Promise<void> {
    emitEvent(new SchedulerStartedEvent());

    while (!stopping && !externalSignal?.aborted) {
      // Nothing in queue — go idle
      if (queue.size === 0) {
        if (running.size === 0) {
          emitEvent(new SchedulerIdleEvent());
        }
        await waitForWake(idleDelay);
        continue;
      }

      const nextTask = queue.peek()!;

      // A task is already running — check if we should preempt
      if (running.size > 0) {
        const activeTask = [...running.values()][0]!;
        if (isHigherPriority(nextTask.priority, activeTask.task.priority)) {
          await preemptTask(activeTask);
          // Now have capacity — fall through to dispatch
        } else {
          // Can't dispatch — wait for the running task to finish
          await waitForWake(idleDelay);
          continue;
        }
      }

      // Apply idle delay for non-immediate tasks
      if (nextTask.priority !== 'immediate' && lastTaskCompletedAt > 0) {
        const elapsed = performance.now() - lastTaskCompletedAt;
        if (elapsed < idleDelay) {
          await waitForWake(idleDelay - elapsed);
          // Re-check state after waking — a higher-priority task may have arrived
          if (stopping || externalSignal?.aborted) break;
          if (queue.peek() !== nextTask) continue; // Queue changed during sleep
        }
      }

      // Dispatch
      const task = queue.dequeue()!;
      await startAndAwaitTask(task);
    }

    emitEvent(new SchedulerStoppedEvent());
  }

  async function preemptTask(runningTask: RunningTask): Promise<void> {
    const { task, abortController } = runningTask;
    abortController.abort('preempted');

    // Wait for the current step to complete
    try {
      await runningTask.result;
    } catch {
      // Swallow — the result will be 'aborted'
    }

    running.delete(task.id);
    preemptedCount++;

    const shouldRequeue =
      (task.requeue ?? (task.priority === 'background' || task.priority === 'ambient')) &&
      runningTask.requeues < (task.maxRequeues ?? 3);

    emitEvent(new TaskPreemptedEvent(task.id, 'preempted', shouldRequeue));

    if (shouldRequeue) {
      const requeuedTask = { ...task, __requeues: runningTask.requeues + 1 };
      queue.enqueue(requeuedTask);
    } else {
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }

    void task.onPreempted?.('preempted');
  }

  /**
   * Starts a task and waits for it to complete. The loop is serial —
   * one task at a time — and allows preemption: if a higher-priority task
   * is submitted while we're waiting, wakeLoop() fires.
   *
   * For preemption to work, we race the task result against a wake signal.
   * When woken by a new submission, we check if preemption is needed.
   */
  async function startAndAwaitTask(task: SchedulerTask & { __requeues?: number }): Promise<void> {
    const abortController = new AbortController();
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal;

    emitEvent(new TaskDispatchedEvent(task.id, task.priority));

    let runOptions: RunOptions;
    try {
      runOptions = await task.createRun();
    } catch (error) {
      emitEvent(new TaskFailedEvent(task.id, error));
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.reject(error);
      }
      return;
    }

    const result = executeLoop({
      ...runOptions,
      generate: runOptions.generate ?? generate,
      toolbox: runOptions.toolbox ?? toolbox,
      signal: combinedSignal,
    });

    const runningTaskEntry: RunningTask = {
      task,
      abortController,
      result,
      requeues: task.__requeues ?? 0,
    };
    running.set(task.id, runningTaskEntry);

    // Wait for the task to complete, checking for preemption opportunities.
    // Track whether the result has settled to avoid preempting a completed task
    // when the wake and result resolve in the same microtask batch.
    let resultSettled = false;
    result.then(() => (resultSettled = true)).catch(() => (resultSettled = true));

    while (running.has(task.id)) {
      const completed = await Promise.race([
        result.then(() => true).catch(() => true),
        new Promise<false>((resolve) => {
          wakeResolver = () => resolve(false);
        }),
      ]);
      wakeResolver = undefined;

      if (completed) break;

      // Woken by new submission — check if preemption is needed.
      // Guard against the race where the result settled in the same microtask
      // as the wake: if the result is already settled, treat it as completed.
      if (resultSettled) break;

      if (queue.hasHigherPriority(task.priority)) {
        await preemptTask(runningTaskEntry);
        return; // The loop will dispatch the higher-priority task
      }
    }

    // Task completed normally
    if (running.has(task.id)) {
      running.delete(task.id);
      try {
        const runResult = await result;
        if (runResult.finishReason !== 'aborted') {
          completedCount++;
          lastTaskCompletedAt = performance.now();
          emitEvent(new TaskCompletedEvent(task.id, runResult));
          const resolver = taskResolvers.get(task.id);
          if (resolver) {
            taskResolvers.delete(task.id);
            resolver.resolve(runResult);
          }
          void task.onComplete?.(runResult);
        } else {
          // Task was aborted (e.g., via external signal) without going through preemptTask.
          // Resolve the submit() promise with null so it doesn't hang forever.
          const resolver = taskResolvers.get(task.id);
          if (resolver) {
            taskResolvers.delete(task.id);
            resolver.resolve(null);
          }
        }
      } catch (error) {
        emitEvent(new TaskFailedEvent(task.id, error));
        const resolver = taskResolvers.get(task.id);
        if (resolver) {
          taskResolvers.delete(task.id);
          resolver.reject(error);
        }
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;
    loopPromise = schedulerLoop();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    stopping = true;

    // Discard queued tasks
    for (const task of queue) {
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }
    queue.clear();

    // Abort non-immediate running tasks
    for (const runningTask of running.values()) {
      if (runningTask.task.priority !== 'immediate') {
        runningTask.abortController.abort('scheduler-stopped');
      }
    }

    wakeLoop();

    // Wait for all running tasks to settle
    const runningResults = [...running.values()].map((r) => r.result.catch(() => {}));
    await Promise.all(runningResults);

    // Resolve any remaining task resolvers (e.g., for aborted tasks)
    for (const [taskId, resolver] of taskResolvers) {
      resolver.resolve(null);
      taskResolvers.delete(taskId);
    }

    if (loopPromise) {
      await loopPromise;
    }

    started = false;
  }

  return {
    submit,
    submitImmediate,
    dispatch: dispatchMethod,
    getState,
    start,
    stop,
    addEventListener: ((type: string, listener: EventListenerOrEventListenerObject) => {
      emitter.addEventListener(type, listener);
    }) as Scheduler['addEventListener'],
    removeEventListener: ((type: string, listener: EventListenerOrEventListenerObject) => {
      emitter.removeEventListener(type, listener);
    }) as Scheduler['removeEventListener'],
  };
}
