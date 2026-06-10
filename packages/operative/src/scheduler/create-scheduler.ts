import type { ActiveRun } from '../create-run';
import { createRun } from '../create-run';
import type { AnyRunEngine, CheckpointStore } from '../durable';
import { resumeDurableRunResult, startDurableRunResult } from '../durable';
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
   *
   * CONTRACT — run-level hooks on the durable path. A DURABLE scheduler task's
   * RUN-level hooks (`RunOptions.hooks.onRunStart`/`onRunComplete`/etc.) do NOT
   * fire: a preemptable run is driven by the hooks-free `startDurableRunResult` so
   * that a preempt→resume cannot double-fire `onRunComplete` (the suspended run's
   * original driver would otherwise re-fire it on resume). The scheduler is the
   * single lifecycle owner for scheduled tasks — use `SchedulerTask.onComplete` /
   * `onPreempted` and the scheduler's `Task*Event`s, which fire exactly once. This
   * is a DELIBERATE divergence from the in-memory path (no engine), where
   * `executeLoop` fires run-level hooks once: scheduled tasks should observe
   * completion via the task callbacks, not run-level hooks, regardless of backend.
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
  // Monotonic suffix for synthetic durable scheduler-run ids, so each fresh
  // dispatch of a task gets a distinct workflow id (a requeued resume reuses the
  // suspended run's id instead — see startAndAwaitTask).
  let durableRunCounter = 0;

  function generateTaskId(): string {
    return `task-${++taskIdCounter}-${Date.now().toString(36)}`;
  }

  const emitter = new EventTarget();
  const queue = createPriorityQueue<QueuedTask>();
  const running = new Map<string, RunningTask>();
  // The CURRENT dispatch that owns each in-flight task, by object identity. Set
  // when a dispatch starts; replaced when the task is suspended-and-redispatched
  // (resume) so the abandoned suspended dispatch's still-settling result
  // continuation can detect — by `currentDispatch.get(id) === self` — that it no
  // longer owns the task and must stay silent (the suspend/resume split-brain
  // guard). A missing entry means no live owner, which is also "not me". This is
  // a distinct map from `running` because a completing dispatch deletes itself
  // from `running` BEFORE its final await, yet must still prove ownership after.
  const currentDispatch = new Map<string, RunningTask>();
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

  // Task ids explicitly cancelled while RUNNING via `cancel()`. For a DURABLE run,
  // `engine.cancel` terminalizes the run by REJECTING its `result()` with
  // "Workflow cancelled" (unlike the in-memory path, where abort settles the
  // result as `aborted`). Without this marker the dispatch's completion catch
  // would REJECT the submit() promise; with it, the catch resolves `null` instead
  // — so a cancelled durable task matches the in-memory cancel contract (submit
  // resolves null, not throws).
  const cancelledRunningTasks = new Set<string>();

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
    };
    running.set(taskId, runningTaskEntry);
    currentDispatch.set(taskId, runningTaskEntry);

    emitEvent(new TaskDispatchedEvent(taskId, 'immediate'));

    // Clean up when the run completes and wake the scheduler loop so it can
    // dispatch the next queued task without waiting for the idle delay timeout.
    const result = activeRun.result.then(
      (runResult) => {
        running.delete(taskId);
        currentDispatch.delete(taskId);
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
        currentDispatch.delete(taskId);
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
      // A queued `__resume` task points to a durable run SUSPENDED by an earlier
      // preemption — dropping the queue entry would orphan it as a `suspended`
      // workflow, so cancel it at the engine (committee review: scheduler cancel
      // must cover durable runs, not just abort the in-memory controller).
      if (durable && queuedTask.__resume) {
        void durable.engine.cancel(queuedTask.__resume.runId).catch((error: unknown) => {
          emitEvent(new TaskFailedEvent(taskId, error));
        });
      }
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

    // A FRESH durable run is wired to its abortController; a RESUMED durable run
    // (driven by resumeDurableRunResult) is NOT, so aborting the controller would
    // not stop it and its API-key services would stay alive. For any durable run,
    // cancel at the engine, which terminalizes it AND settles its result — the
    // dispatch's own completion path then resolves the task (ownership intact, so
    // it is not double-resolved). For an in-memory run, abort the controller as
    // before; its result settles `aborted` and the completion path resolves null.
    if (durable && runningTask.durableRunId !== undefined) {
      // Mark it cancelled so the dispatch's completion catch resolves null (the
      // engine.cancel rejects result() with "Workflow cancelled") instead of
      // rejecting the submit() promise — matching the in-memory cancel contract.
      cancelledRunningTasks.add(taskId);
      void durable.engine.cancel(runningTask.durableRunId).catch((error: unknown) => {
        emitEvent(new TaskFailedEvent(taskId, error));
      });
    } else {
      runningTask.abortController.abort('cancelled');
    }
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
   * preempted, not requeued). Clears the current dispatch owner first so the
   * detached dispatch's result continuation can never also resolve it.
   */
  function resolvePreemptedTaskNull(taskId: string): void {
    currentDispatch.delete(taskId);
    const resolver = taskResolvers.get(taskId);
    if (resolver) {
      taskResolvers.delete(taskId);
      resolver.resolve(null);
    }
  }

  /** Whether `entry` is still the live dispatch owner for its task. */
  function ownsTask(entry: RunningTask): boolean {
    return currentDispatch.get(entry.task.id) === entry;
  }

  /**
   * Preempt a DURABLE task by SUSPENDING its run and detaching — WITHOUT awaiting
   * its result (Weft's `engine.suspend` leaves `handle.result()` pending until a
   * later resume, so awaiting here would deadlock the serial loop). The suspended
   * run keeps its checkpoint + in-memory services; a requeue resumes it.
   */
  /**
   * Suspend a durable run and detach it for a later resume. Returns `true` when
   * the task was actually preempted (removed from `running`, requeued or
   * resolved); returns `false` when the run had ALREADY settled before it could be
   * parked (suspend threw or the status is not `suspended`) — in that case the
   * original dispatch STILL owns the task and must fall through to its normal
   * completion path, NOT treat the task as preempted (committee review: otherwise
   * the task is left stuck in `running` and the serial loop blocks forever).
   */
  async function suspendAndDetach(runningTask: RunningTask, runId: string): Promise<boolean> {
    const { task } = runningTask;

    if (!durable) return false; // unreachable — a durableRunId implies an engine

    // Suspend BEFORE relinquishing ownership. engine.suspend parks the run
    // (running→suspended), preserving its checkpoint + in-memory services; it does
    // NOT abort the signal and does NOT settle result(). CRITICAL (committee MF-1):
    // suspend is a no-op if the run already left `running` — completed, failed, or
    // a concurrent cancel won. If we relinquished ownership / enqueued a resume
    // before confirming the suspend, a run that actually COMPLETED would be
    // neutered (its result continuation silenced) AND a resume enqueued for a
    // terminal run. So we only detach + requeue once we know the run is genuinely
    // parked. Distinguish via the run's status after the call.
    try {
      await durable.engine.suspend(runId);
    } catch (error) {
      // The engine is disposed (teardown) or the suspend write faulted. Do NOT
      // detach: leave ownership with the original dispatch so its result
      // continuation settles the task exactly once. Surface the error and report
      // "not preempted" so the caller falls through to the completion path.
      emitEvent(new TaskFailedEvent(task.id, error));
      return false;
    }

    // If the run is NOT actually suspended (it completed/failed before suspend
    // could park it — suspend no-op'd), the original dispatch still owns the task
    // and its result continuation will settle it. Detaching here would race that —
    // and reporting "preempted" would strand the task in `running`. Report "not
    // preempted" so the caller drives the normal completion path instead.
    const state = await durable.engine.get(runId);
    if (state?.status !== 'suspended') {
      return false;
    }

    // The run is parked. Relinquish ownership: the original `ActiveRun.result`
    // still settles when the SAME workflow later completes via resume, so the
    // abandoned continuation must see (via ownsTask) that it no longer owns the
    // task and stay silent.
    if (currentDispatch.get(task.id) === runningTask) {
      currentDispatch.delete(task.id);
    }
    running.delete(task.id);
    preemptedCount++;

    // Re-check `stopping` after the async suspend/get gap (committee round-2
    // finding 3): if stop() cleared the queue while we were parking this run,
    // enqueueing a __resume now would strand a queued resume with no dispatcher
    // and leave its submit() resolver unresolved. So when stopping, cancel the
    // parked run and resolve null instead of requeueing.
    const requeue = !stopping && shouldRequeueOnPreempt(task, runningTask.requeues);
    emitEvent(new TaskPreemptedEvent(task.id, 'preempted', requeue));

    if (requeue) {
      // Requeue resume intent. The suspended runId lives in this queue entry (and
      // is the ONLY pointer to the paused run) — no durable registry: the whole
      // scheduler is in-memory, so a hard crash loses this queued task exactly as
      // it loses every other queued/running task. stop() cancels any still-paused
      // run so it never dangles as a `suspended` workflow. The hard-crash residue
      // (a `suspended` weft run with no in-memory pointer) is a documented seam,
      // symmetric to the rest of the volatile scheduler.
      const requeuedTask: QueuedTask = {
        ...task,
        __requeues: runningTask.requeues + 1,
        __resume: { runId },
      };
      queue.enqueue(requeuedTask);
    } else {
      // Not requeued — cancel the suspended run (it will never resume) so it does
      // not linger as a dangling `suspended` workflow. AWAIT the cancel (committee
      // MF-6) so a cancel failure surfaces deterministically rather than leaving
      // the run suspended while the scheduler treats the task as done.
      try {
        await durable.engine.cancel(runId);
      } catch (error) {
        emitEvent(new TaskFailedEvent(task.id, error));
      }
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }

    void task.onPreempted?.('preempted');
    return true;
  }

  /**
   * Preempt a running task. Returns `true` when the task was actually preempted
   * (the caller must then return from its dispatch and let the loop pick up the
   * higher-priority work); returns `false` when a durable run had already settled
   * and could not be parked — the caller then falls through to the normal
   * completion path so the task is not stranded in `running`.
   */
  async function preemptTask(runningTask: RunningTask): Promise<boolean> {
    // Durable task → suspend + detach (no await), so a requeue resumes from the
    // checkpoint rather than restarting. In-memory task → abort + re-run.
    if (runningTask.durableRunId !== undefined) {
      return suspendAndDetach(runningTask, runningTask.durableRunId);
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
    return true;
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
      durableRunId = `scheduler-run-${task.id}-${++durableRunCounter}`;
      let runOptions: SchedulerRunOptions;
      try {
        runOptions = await task.createRun();
      } catch (error) {
        failDispatch(task.id, error);
        return;
      }
      // HOOKS-FREE durable start (not createDurableActiveRun): a preemptable run
      // is suspended on preemption, which does not settle its handle, so a
      // hook-firing driver would fire onRunComplete a second time when the run
      // resumes-and-completes. startDurableRunResult fires no run hooks — the
      // scheduler is the single lifecycle owner (Task*Events + task.onComplete).
      result = startDurableRunResult(
        { engine: durable.engine, checkpointStore: durable.checkpointStore },
        {
          runId: durableRunId,
          sessionId: durableRunId,
          options: {
            ...runOptions,
            generate: runOptions.generate ?? generate,
            toolbox: runOptions.toolbox ?? toolbox,
            signal: combinedSignal,
          },
          signal: combinedSignal,
        },
      );
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
      ...(durableRunId !== undefined ? { durableRunId } : {}),
    };
    running.set(task.id, runningTaskEntry);
    // Claim ownership by object identity. A suspend-and-detach (resume) replaces
    // this with a new dispatch entry, so this continuation can detect — via
    // ownsTask — that it was superseded and must stay silent.
    currentDispatch.set(task.id, runningTaskEntry);

    // Wait for the task to complete, checking for preemption opportunities.
    // Track whether the result has settled to avoid preempting a completed task
    // when the wake and result resolve in the same microtask batch.
    let resultSettled = false;
    result.then(() => (resultSettled = true)).catch(() => (resultSettled = true));

    while (running.has(task.id) && ownsTask(runningTaskEntry)) {
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
        // preemptTask returns false when a durable run had ALREADY settled and
        // could not be parked — in that case this dispatch still owns the task, so
        // fall through to the completion path below instead of returning (which
        // would strand the task in `running` and block the serial loop forever).
        if (await preemptTask(runningTaskEntry)) {
          return; // Preempted — the loop will dispatch the higher-priority task.
        }
        break; // Not preempted (run already settled) — go finish the task.
      }
    }

    // OWNERSHIP GUARD (committee MF-2): a suspend-and-detach replaces this entry
    // as the current dispatch and deletes the task from `running`. The original
    // durable `result` promise still settles later (the SAME workflow completes
    // via resume), but this continuation no longer owns the task — so it must NOT
    // resolve the resolver, fire TaskCompletedEvent, or touch the counts. The
    // resume dispatch owns those.
    if (!running.has(task.id) || !ownsTask(runningTaskEntry)) {
      return;
    }

    running.delete(task.id);
    try {
      const runResult = await result;
      // Re-check ownership after the await: a preemption could have landed while
      // the result settled in the same tick.
      if (!ownsTask(runningTaskEntry)) return;
      currentDispatch.delete(task.id);
      cancelledRunningTasks.delete(task.id);
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
      if (!ownsTask(runningTaskEntry)) return;
      currentDispatch.delete(task.id);
      const resolver = taskResolvers.get(task.id);
      // An explicit cancel() of a running DURABLE task terminalizes it via
      // engine.cancel, which REJECTS result() with "Workflow cancelled". That is a
      // cancellation, not a failure — resolve the submit() promise with `null` to
      // match the in-memory cancel contract, and fire no TaskFailedEvent (the
      // TaskCancelledEvent already fired in cancel()).
      if (cancelledRunningTasks.delete(task.id)) {
        if (resolver) {
          taskResolvers.delete(task.id);
          resolver.resolve(null);
        }
        return;
      }
      emitEvent(new TaskFailedEvent(task.id, error));
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.reject(error);
      }
    }
  }

  /** Reject a task whose `createRun()` factory threw before any run started. */
  function failDispatch(taskId: string, error: unknown): void {
    currentDispatch.delete(taskId);
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
   * identical. Unlike the recovery reattach, a failed resume/result PROPAGATES
   * (rejects) so the scheduler surfaces it as a failed task (committee MF-4).
   */
  function resumeDurableRun(
    durableContext: SchedulerDurableContext,
    runId: string,
  ): Promise<RunResult> {
    return resumeDurableRunResult(
      { engine: durableContext.engine, checkpointStore: durableContext.checkpointStore },
      runId,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;
    // `externalSignal` is documented as "shut down the entire scheduler". The
    // loop already exits when it aborts, but a RESUMED durable run is driven by
    // `resumeDurableRunResult` (not wired to any abortController), so the loop
    // exiting does NOT stop it — it would outlive the scheduler with its API-key
    // services alive (committee review). Route the abort through the full `stop()`
    // shutdown path, which engine.cancels every durable run. Fire if it is already
    // aborted at start.
    if (externalSignal) {
      if (externalSignal.aborted) {
        void stop();
      } else {
        externalSignal.addEventListener('abort', () => void stop(), { once: true });
      }
    }
    loopPromise = schedulerLoop();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    stopping = true;

    // Collect every durable cancel so stop() can AWAIT them (committee round-2
    // finding 3): a fire-and-forget cancel would let stop() return while suspended
    // workflows — and their in-memory API-key `services` — are still alive, which
    // defeats stop() as a credential-lifetime boundary.
    const durableCancellations: Promise<void>[] = [];

    // Discard queued tasks. A queued task carrying `__resume` points to a durable
    // run SUSPENDED by an earlier preemption — the queue entry is the only pointer
    // to it. Cancelling terminalizes the suspended run (so it does not dangle as a
    // `suspended` workflow) AND rejects its pending result waiter (Weft:
    // "cancel/fail transition a suspended workflow to terminal and reject
    // outstanding result() waiters"). This closes both the dangling-record and the
    // shutdown-hang on a suspended run in one pass.
    for (const task of queue) {
      if (durable && task.__resume) {
        durableCancellations.push(durable.engine.cancel(task.__resume.runId));
      }
      const resolver = taskResolvers.get(task.id);
      if (resolver) {
        taskResolvers.delete(task.id);
        resolver.resolve(null);
      }
    }
    queue.clear();

    // Stop non-immediate running tasks. A FRESH durable run is wired to its
    // abortController (the signal flows into the run), so aborting it settles its
    // result `aborted`. A RESUMED durable run is driven by `resumeDurableRunResult`
    // and is NOT wired to this abortController, so aborting it would do nothing and
    // it would keep executing past stop — keeping API-key `services` alive
    // (committee MF-3). So for ANY running durable task, `engine.cancel(runId)`,
    // which terminalizes the run AND settles its result; for non-durable tasks,
    // abort as before.
    for (const runningTask of running.values()) {
      if (runningTask.task.priority === 'immediate') continue;
      if (durable && runningTask.durableRunId !== undefined) {
        // Mark it cancelled so the dispatch's completion catch resolves its
        // submit() promise `null` (engine.cancel rejects result() with "Workflow
        // cancelled") instead of REJECTING it — matching explicit cancel() and the
        // in-memory abort-on-stop path (Bugbot: stop must not reject durable
        // submit promises).
        cancelledRunningTasks.add(runningTask.task.id);
        durableCancellations.push(durable.engine.cancel(runningTask.durableRunId));
      } else {
        runningTask.abortController.abort('scheduler-stopped');
      }
    }

    wakeLoop();

    // Await the durable cancels AND all running task results, so a stopped
    // scheduler has genuinely released every run's services before returning.
    // Cancel failures are NOT swallowed pre-await (committee round-3 finding 3): a
    // run whose cancel REJECTED may still hold its services alive, so surface it as
    // a scheduler-level failure event rather than reporting a clean stop.
    const cancelOutcomes = await Promise.allSettled([
      ...durableCancellations,
      ...[...running.values()].map((runningTask) => runningTask.result),
    ]);
    for (const outcome of cancelOutcomes) {
      if (outcome.status === 'rejected') {
        emitEvent(new TaskFailedEvent('scheduler-stop-cancel', outcome.reason));
      }
    }

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
