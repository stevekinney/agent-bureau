import type { ActiveRun } from '../create-run';
import { createRun } from '../create-run';
import type { AnyRunEngine, CheckpointStore, RecoveredRunHandle } from '../durable';
import { reattachDurableActiveRun } from '../durable';
import { executeLoop } from '../loop';
import type { GenerateFunction, RunResult, Toolbox } from '../types';
import type { SchedulerEventMap, SchedulerEventType } from './events';
import {
  SchedulerIdleEvent,
  SchedulerStartedEvent,
  SchedulerStoppedEvent,
  TaskCancelledEvent,
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
  SchedulerRunOptions,
  SchedulerState,
  SchedulerTask,
  SchedulerTaskSummary,
} from './types';

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
  /**
   * The durable run engine. When present, preemptable tasks run as durable
   * workflows and PREEMPTION SUSPENDS the run (preserving its checkpoint) instead
   * of aborting it — a requeued task RESUMES from its last completed step rather
   * than restarting from scratch. Omit for the in-memory scheduler (library use):
   * preemption then aborts + re-runs the task factory, as before.
   *
   * In-process suspend→resume reuses the run's preserved in-memory `services`
   * (Weft does not re-consult the resolver same-process), so the resumed run keeps
   * its exact `generate`/`toolbox` with no rebuild.
   */
  durable?: SchedulerDurableContext;
}

/** The durable-engine wiring a scheduler needs to suspend/resume preempted tasks. */
export interface SchedulerDurableContext {
  engine: AnyRunEngine;
  checkpointStore: CheckpointStore;
}

/**
 * The scheduler interface returned by createScheduler.
 */
export interface Scheduler {
  /** Submit a task to the scheduler. Resolves when the task completes, or null if permanently preempted. */
  submit(task: SchedulerTask): Promise<RunResult | null>;
  /** Convenience: submit an immediate-priority task. Resolves with the run result, or null if the scheduler is stopping. */
  submitImmediate(
    createRunFactory: () => SchedulerRunOptions | Promise<SchedulerRunOptions>,
  ): Promise<RunResult | null>;
  /** Eagerly creates an ActiveRun for immediate-priority tasks. Returns both the
   *  ActiveRun handle (for store registration / event forwarding) and the result promise.
   *  The factory must be synchronous — use submit() for async factories. */
  dispatch(createRunFactory: () => SchedulerRunOptions): {
    activeRun: ActiveRun;
    result: Promise<RunResult>;
  };
  /** Get the current scheduler state. */
  getState(): SchedulerState;
  /** Cancel a queued or running task by id. Returns true when a task was found. */
  cancel(taskId: string): boolean;
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
  /**
   * A monotonic token identifying THIS dispatch of the task. Incremented every
   * time the task is suspended-and-detached, so a stale `result` continuation
   * from a prior (now-suspended) dispatch can detect it no longer owns the task
   * and must not resolve/emit. Closes the suspend/resume split-brain: the original
   * durable `ActiveRun.result` promise still settles after a later resume (the
   * SAME workflow drives to terminal), so without this guard the abandoned
   * continuation would double-resolve the task resolver and double-fire events.
   */
  ownerGeneration: number;
  /**
   * The durable workflow id, when this task runs as a durable engine workflow.
   * Present ⇒ preemption SUSPENDS this run (`engine.suspend(runId)`) and a requeue
   * RESUMES it; absent ⇒ preemption aborts + re-runs the factory (in-memory path).
   */
  durableRunId?: string;
}

/**
 * A task carrying internal scheduler bookkeeping across the queue: the requeue
 * count and, for a durable task being requeued after suspension, the resume
 * intent (the suspended run's id). A resume-flagged task is re-dispatched by
 * RESUMING its existing durable run, not by calling `createRun()` afresh.
 */
type QueuedTask = SchedulerTask & {
  __requeues?: number;
  __resume?: { runId: string };
};

function taskSummary(task: SchedulerTask): SchedulerTaskSummary {
  return { id: task.id, priority: task.priority, metadata: task.metadata };
}

/**
 * Creates a priority-aware scheduler that dispatches tasks, manages the active run,
 * and handles preemption between operative steps.
 */
export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const { generate, toolbox, idleDelay = 1000, signal: externalSignal, durable } = options;

  let taskIdCounter = 0;

  function generateTaskId(): string {
    return `task-${++taskIdCounter}-${Date.now().toString(36)}`;
  }

  const emitter = new EventTarget();
  const queue = createPriorityQueue<QueuedTask>();
  const running = new Map<string, RunningTask>();
  // Per-task ownership generation. Bumped on every suspend-and-detach so a stale
  // result continuation from the suspended dispatch can detect it no longer owns
  // the task (see RunningTask.ownerGeneration).
  const taskGenerations = new Map<string, number>();
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
    createRunFactory: () => SchedulerRunOptions | Promise<SchedulerRunOptions>,
  ): Promise<RunResult | null> {
    const taskId = generateTaskId();
    const task: SchedulerTask = {
      id: taskId,
      priority: 'immediate',
      createRun: createRunFactory,
      requeue: false,
    };
    return submit(task);
  }

  function dispatchMethod(createRunFactory: () => SchedulerRunOptions): {
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
      // Immediate tasks are the highest lane and are never preempted, so this
      // generation is never bumped; it exists only to satisfy the shape.
      ownerGeneration: bumpGeneration(taskId),
    };
    running.set(taskId, runningTaskEntry);

    emitEvent(new TaskDispatchedEvent(taskId, 'immediate'));

    // Clean up when the run completes and wake the scheduler loop so it can
    // dispatch the next queued task without waiting for the idle delay timeout.
    const result = activeRun.result.then(
      (runResult) => {
        running.delete(taskId);
        if (runResult.finishReason !== 'aborted') {
          completedCount++;
          lastTaskCompletedAt = performance.now();
          emitEvent(new TaskCompletedEvent(taskId, runResult));
        }
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

  function cancel(taskId: string): boolean {
    const queuedTask = queue.remove((task) => task.id === taskId);
    if (queuedTask) {
      const resolver = taskResolvers.get(taskId);
      if (resolver) {
        taskResolvers.delete(taskId);
        resolver.resolve(null);
      }

      emitEvent(new TaskCancelledEvent(taskId, 'queued'));
      wakeLoop();
      return true;
    }

    const runningTask = running.get(taskId);
    if (!runningTask) {
      return false;
    }

    runningTask.abortController.abort('cancelled');
    emitEvent(new TaskCancelledEvent(taskId, 'running'));
    wakeLoop();
    return true;
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

      // A task is already running. This only happens when dispatch() has created
      // an immediate run outside the queue-driven loop, so no queued task can
      // legitimately outrank it.
      if (running.size > 0) {
        await waitForWake(idleDelay);
        continue;
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

  /**
   * Whether a requeue should happen for a preempted task: its policy allows it
   * (explicit `requeue`, else default by lane) and it is under the requeue cap.
   */
  function shouldRequeueOnPreempt(task: SchedulerTask, requeues: number): boolean {
    return (
      (task.requeue ?? (task.priority === 'background' || task.priority === 'ambient')) &&
      requeues < (task.maxRequeues ?? 3)
    );
  }

  /**
   * Resolve a preempted task's submit() promise with `null` (permanently
   * preempted, not requeued). Bumps the ownership generation first so the
   * detached dispatch's result continuation can never also resolve it.
   */
  function resolvePreemptedTaskNull(taskId: string): void {
    bumpGeneration(taskId);
    const resolver = taskResolvers.get(taskId);
    if (resolver) {
      taskResolvers.delete(taskId);
      resolver.resolve(null);
    }
  }

  /** Increment a task's ownership generation, invalidating its current dispatch. */
  function bumpGeneration(taskId: string): number {
    const next = (taskGenerations.get(taskId) ?? 0) + 1;
    taskGenerations.set(taskId, next);
    return next;
  }

  /**
   * Preempt a DURABLE task by SUSPENDING its run and detaching — WITHOUT awaiting
   * its result (Weft's `engine.suspend` leaves `handle.result()` pending until a
   * later resume, so awaiting here would deadlock the serial loop). The suspended
   * run keeps its checkpoint + in-memory services; a requeue resumes it.
   */
  async function suspendAndDetach(runningTask: RunningTask, runId: string): Promise<void> {
    const { task } = runningTask;

    // Invalidate the current dispatch BEFORE suspending: the original
    // `ActiveRun.result` promise still settles when the SAME workflow later
    // completes via resume, so the abandoned continuation must see it no longer
    // owns the task and stay silent (the ownership guard in startAndAwaitTask).
    bumpGeneration(task.id);

    // engine.suspend parks the run (status running→suspended), preserving its
    // checkpoint and in-memory services; it does NOT abort the run's signal and
    // does NOT settle result(). We deliberately do NOT abort the run's
    // AbortController here — a suspend is a pause, not a cancel.
    if (durable) {
      try {
        await durable.engine.suspend(runId);
      } catch (error) {
        // Suspend lost a race to the run completing/failing (idempotent no-op in
        // Weft), or the engine is disposed. Either way the run is no longer
        // ours to resume; fall through to drop it from `running` and let the
        // detached continuation (now non-owning) settle harmlessly.
        emitEvent(new TaskFailedEvent(task.id, error));
      }
    }

    running.delete(task.id);
    preemptedCount++;

    const requeue = shouldRequeueOnPreempt(task, runningTask.requeues);
    emitEvent(new TaskPreemptedEvent(task.id, 'preempted', requeue));

    if (requeue) {
      // Requeue resume intent. The suspended runId lives in this queue entry (and
      // is the ONLY pointer to the paused run) — no durable registry: the whole
      // scheduler is in-memory, so a hard crash loses this queued task exactly as
      // it loses every other queued/running task. stop() cancels any still-paused
      // run so it never dangles as a `suspended` workflow (see stop()). The
      // hard-crash residue (a `suspended` weft run with no in-memory pointer) is a
      // documented seam, symmetric to the rest of the volatile scheduler.
      const requeuedTask: QueuedTask = {
        ...task,
        __requeues: runningTask.requeues + 1,
        __resume: { runId },
      };
      queue.enqueue(requeuedTask);
    } else {
      // Not requeued — cancel the suspended run (it will never resume) so it does
      // not linger as a dangling `suspended` workflow, then resolve null.
      if (durable) {
        void durable.engine.cancel(runId).catch(() => {});
      }
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }

    void task.onPreempted?.('preempted');
  }

  async function preemptTask(runningTask: RunningTask): Promise<void> {
    // Durable task → suspend + detach (no await), so a requeue resumes from the
    // checkpoint rather than restarting. In-memory task → abort + re-run.
    if (runningTask.durableRunId !== undefined) {
      await suspendAndDetach(runningTask, runningTask.durableRunId);
      return;
    }

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

    const shouldRequeue = shouldRequeueOnPreempt(task, runningTask.requeues);

    emitEvent(new TaskPreemptedEvent(task.id, 'preempted', shouldRequeue));

    if (shouldRequeue) {
      const requeuedTask: QueuedTask = { ...task, __requeues: runningTask.requeues + 1 };
      queue.enqueue(requeuedTask);
    } else {
      resolvePreemptedTaskNull(task.id);
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
  async function startAndAwaitTask(task: QueuedTask): Promise<void> {
    const abortController = new AbortController();
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal;

    emitEvent(new TaskDispatchedEvent(task.id, task.priority));

    // Claim ownership for THIS dispatch. A later suspend bumps the generation, so
    // the result continuation below can detect it was superseded by a resume.
    const generation = bumpGeneration(task.id);

    // Build the run for this dispatch. Three shapes:
    //  - resume: a durable task requeued after suspension → resume its existing
    //    run from the checkpoint (NOT a fresh createRun), reusing preserved
    //    in-memory services. Continues at the last completed step.
    //  - durable fresh: a durable task's first dispatch → a checkpointed run with
    //    a stable runId so a later preemption can suspend it.
    //  - in-memory: no engine → the original non-durable executeLoop.
    let result: Promise<RunResult>;
    let durableRunId: string | undefined;
    if (durable && task.__resume) {
      durableRunId = task.__resume.runId;
      result = resumeDurableRun(durable, durableRunId);
    } else if (durable) {
      durableRunId = `scheduler-run-${task.id}-${bumpGeneration(`${task.id}:run`)}`;
      let runOptions: SchedulerRunOptions;
      try {
        runOptions = await task.createRun();
      } catch (error) {
        failDispatch(task.id, error);
        return;
      }
      result = createRun(
        {
          ...runOptions,
          generate: runOptions.generate ?? generate,
          toolbox: runOptions.toolbox ?? toolbox,
          signal: combinedSignal,
        },
        {
          engine: durable.engine,
          checkpointStore: durable.checkpointStore,
          runId: durableRunId,
          sessionId: durableRunId,
        },
      ).result;
    } else {
      let runOptions: SchedulerRunOptions;
      try {
        runOptions = await task.createRun();
      } catch (error) {
        failDispatch(task.id, error);
        return;
      }
      result = executeLoop({
        ...runOptions,
        generate: runOptions.generate ?? generate,
        toolbox: runOptions.toolbox ?? toolbox,
        signal: combinedSignal,
      });
    }

    const runningTaskEntry: RunningTask = {
      task,
      abortController,
      result,
      requeues: task.__requeues ?? 0,
      ownerGeneration: generation,
      ...(durableRunId !== undefined ? { durableRunId } : {}),
    };
    running.set(task.id, runningTaskEntry);

    // Wait for the task to complete, checking for preemption opportunities.
    // Track whether the result has settled to avoid preempting a completed task
    // when the wake and result resolve in the same microtask batch.
    let resultSettled = false;
    result.then(() => (resultSettled = true)).catch(() => (resultSettled = true));

    while (running.has(task.id) && ownsTask(task.id, generation)) {
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

    // OWNERSHIP GUARD: a suspend-and-detach bumps the generation and deletes the
    // task from `running`. The original durable `result` promise still settles
    // later (the SAME workflow completes via resume), but this continuation no
    // longer owns the task — so it must NOT resolve the resolver, fire
    // TaskCompletedEvent, or touch the counts. The resume dispatch owns those.
    if (!running.has(task.id) || !ownsTask(task.id, generation)) {
      return;
    }

    running.delete(task.id);
    try {
      const runResult = await result;
      // Re-check ownership after the await: a preemption could have landed while
      // the result settled in the same tick.
      if (!ownsTask(task.id, generation)) return;
      if (runResult.finishReason !== 'aborted') {
        completedCount++;
        lastTaskCompletedAt = performance.now();
        taskGenerations.delete(task.id);
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
        taskGenerations.delete(task.id);
        const resolver = taskResolvers.get(task.id);
        if (resolver) {
          taskResolvers.delete(task.id);
          resolver.resolve(null);
        }
      }
    } catch (error) {
      if (!ownsTask(task.id, generation)) return;
      taskGenerations.delete(task.id);
      emitEvent(new TaskFailedEvent(task.id, error));
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.reject(error);
      }
    }
  }

  /** Whether `generation` is still the live ownership generation for `taskId`. */
  function ownsTask(taskId: string, generation: number): boolean {
    return (taskGenerations.get(taskId) ?? generation) === generation;
  }

  /** Reject a task whose `createRun()` factory threw before any run started. */
  function failDispatch(taskId: string, error: unknown): void {
    taskGenerations.delete(taskId);
    emitEvent(new TaskFailedEvent(taskId, error));
    const resolver = taskResolvers.get(taskId);
    if (resolver) {
      taskResolvers.delete(taskId);
      resolver.reject(error);
    }
  }

  /**
   * Resume a suspended durable run from its checkpoint, returning a `RunResult`
   * promise that settles when the resumed run completes — the same shape the
   * fresh-dispatch path produces, so the dispatcher's completion logic is
   * identical. Uses {@link reattachDurableActiveRun} to wrap the resumed handle.
   */
  function resumeDurableRun(
    durableContext: SchedulerDurableContext,
    runId: string,
  ): Promise<RunResult> {
    return durableContext.engine.resume(runId).then((handle) => {
      const reattached = reattachDurableActiveRun(
        { engine: durableContext.engine, checkpointStore: durableContext.checkpointStore },
        { runId, handle: handle as RecoveredRunHandle },
      );
      return reattached.result;
    });
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

    // Discard queued tasks. A queued task carrying `__resume` points to a durable
    // run SUSPENDED by an earlier preemption — the queue entry is the only pointer
    // to it. Cancelling terminalizes the suspended run (so it does not dangle as a
    // `suspended` workflow) AND rejects its pending result waiter (Weft:
    // "cancel/fail transition a suspended workflow to terminal and reject
    // outstanding result() waiters"). This closes both the dangling-record and the
    // shutdown-hang on a suspended run in one pass.
    for (const task of queue) {
      if (durable && task.__resume) {
        void durable.engine.cancel(task.__resume.runId).catch(() => {});
      }
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }
    queue.clear();

    // Abort non-immediate running tasks. A running durable task's abort flows into
    // the run via its combined signal (in-band stop), so its result settles
    // `aborted` and the allSettled below does not hang.
    for (const runningTask of running.values()) {
      if (runningTask.task.priority !== 'immediate') {
        runningTask.abortController.abort('scheduler-stopped');
      }
    }

    wakeLoop();

    // Wait for all running tasks to settle
    await Promise.allSettled([...running.values()].map((runningTask) => runningTask.result));

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
    cancel,
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
