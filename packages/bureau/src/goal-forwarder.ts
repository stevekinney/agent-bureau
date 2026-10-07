/**
 * COR-851 — carries an attempt's ending from its run to its goal's controller.
 *
 * The controller waits for a signal named `attempt-terminal:<n>`; nothing in
 * the run tells it to send one. This does. It watches the attempt's durable run
 * and, once the run is terminal, reads how it ended from the engine's stored
 * state and checkpoint (never from a live handle, so the payload is the same
 * whichever process reads it) and sends the signal under a stable id.
 *
 * Before sending, it commits the attempt's transcript to the goal's session
 * (`GoalConversations.settle`), so the next attempt and the validator always
 * find it, on the live path and the recovery path alike.
 *
 * A failure while forwarding (a session store or engine hiccup) is retried with
 * backoff, the last configured delay repeating, and diagnosed once when the
 * configured retries are spent, since nothing else would send the signal until
 * the next boot.
 *
 * A watch ends only when the attempt's run does. A wait that returns while the
 * run is still going (a handle that rejected on a persistence fault) is
 * followed by a read of the run, and a run still going is waited on again after
 * a bounded, repeating backoff. Every backoff is a pause that `drain()` can
 * release, so shutdown does not leave a goal's timers behind.
 *
 * Three things keep a lost forwarder from parking a goal forever:
 *
 * - The signal id is `attempt-terminal:<goalRunId>:<n>`, so sending it twice
 *   delivers it once and `reconcile()` may be called as often as recovery likes.
 * - Weft buffers a signal for a workflow that has not reached its wait, so an
 *   attempt that ends before the controller parks is not lost.
 * - A process that dies with attempts in flight leaves no forwarder behind;
 *   recovery calls `reconcile()` for every goal still waiting, which re-sends
 *   for a run that ended while nobody was watching and re-attaches for one that
 *   is still going.
 *
 * Nothing is sent once the goal is terminal or has a cancellation marker, since
 * the controller no longer waits for it, and nothing is sent once the bureau
 * is closing: a run ended by shutdown is a crash for the next process to
 * recover, never a verdict for the goal.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentRun,
  type DurableActiveRunContext,
  type FinishReason,
  type GoalAttemptTerminalSignal,
  goalAttemptTerminalSignalName,
  readDurableRunResult,
  type RunOptions,
} from '@lostgradient/operative';

import type { GoalConversations } from './goal-conversation';
import { attemptSignalId, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type { GoalStore } from './goal-store';
import type { DiagnosticSink } from './types';

export interface AttemptTarget {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly runId: string;
}

export interface AttemptForwarderDependencies {
  readonly store: GoalStore;
  readonly runtime: RuntimeServices;
  readonly getDurable: () => DurableActiveRunContext | undefined;
  /**
   * The cost estimation the attempt's run was started with, as persisted with it
   * (never resolved from the catalog afterwards). Always asked: the result is
   * rebuilt with it whether or not the goal bounds cost.
   */
  readonly resolveCostEstimation: (runId: string) => Promise<RunOptions['costEstimation']>;
  /** Commits a finished attempt's transcript to its session before the controller is told it ended. */
  readonly conversations: Pick<GoalConversations, 'settle'>;
  readonly isClosing: () => boolean;
  readonly diagnose: DiagnosticSink;
  /**
   * How long to wait before each further try when forwarding an attempt's end
   * fails (a store or engine hiccup); one entry per retry. Defaults to
   * {@link DEFAULT_FORWARD_RETRY_DELAYS_MS}. Once they are spent the failure is
   * diagnosed once and the last delay repeats until the signal is sent or the
   * bureau closes.
   */
  readonly retryDelaysMs?: readonly number[] | undefined;
}

/** Four delays over about eight seconds, the last one repeating for as long as the attempt is watched. */
export const DEFAULT_FORWARD_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1_600, 6_400];

export type AttemptReconciliation =
  /** The run is alive; a watcher is attached. */
  | 'watching'
  /** The run had ended; its signal was sent. */
  | 'signal-resent'
  /** No run exists under this id. */
  | 'missing'
  /** Nothing to send: the goal ended, was canceled, or the bureau is closing. */
  | 'not-needed';

export interface AttemptForwarder {
  /** Idempotent per run id. `live` is the in-process handle of a run this process started. */
  watch(target: AttemptTarget, live?: AgentRun<unknown, boolean>): void;
  reconcile(target: AttemptTarget): Promise<AttemptReconciliation>;
  /** Resolves once every send already under way has finished. It does not wait on a running attempt. */
  drain(): Promise<void>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createAttemptForwarder(
  dependencies: AttemptForwarderDependencies,
): AttemptForwarder {
  const { store, runtime, getDurable, resolveCostEstimation, conversations, isClosing, diagnose } =
    dependencies;
  const retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_FORWARD_RETRY_DELAYS_MS;
  const watching = new Map<string, Promise<void>>();
  const sending = new Set<Promise<unknown>>();

  /** Sends the attempt's terminal signal if its run has ended. */
  async function forward(target: AttemptTarget): Promise<AttemptReconciliation> {
    if (isClosing()) return 'not-needed';
    // No engine is not an ended goal: nothing can be read to forward, and
    // `not-needed` would tell recovery there is nothing owed. It is a fault the
    // caller retries or reports.
    const durable = getDurable();
    if (durable === undefined) {
      throw new Error("The bureau has no durable engine to read an attempt's ending with.");
    }
    const record = await store.get(target.goalRunId);
    if (
      record === undefined ||
      isTerminalGoalStatus(record.status) ||
      record.cancellation !== undefined
    ) {
      return 'not-needed';
    }
    // The result is always rebuilt with the estimator the run was started with,
    // so the signal and the goal's usage carry the cost the live run had whether
    // or not the goal bounds cost. The bound only decides whether a MISSING
    // estimate is fatal (the controller fails an attempt it cannot account). A
    // resolver that fails here is not an attempt that has no cost: reading the
    // result without an estimate would be recorded as `costUnaccounted` and end
    // the goal over a fault that may be gone by the next try. The failure
    // propagates, so the forwarder retries it and recovery sends the signal.
    const costEstimation = await resolveCostEstimation(target.runId);
    const reading = await readDurableRunResult(durable, target.runId, { runtime, costEstimation });
    if (reading.status === 'missing') return 'missing';
    if (reading.status === 'not-terminal') return 'watching';
    if (isClosing()) return 'not-needed';
    // Committing writes the goal's session, so it is authorized by a read taken
    // now, not the one above: the reads of the run and the cost estimate between
    // them can outlast a cancellation or a duration-terminal transition, and a
    // finished or canceled goal's session is not this forwarder's to change.
    const current = await store.get(target.goalRunId);
    if (
      current === undefined ||
      isTerminalGoalStatus(current.status) ||
      current.cancellation !== undefined
    ) {
      return 'not-needed';
    }
    // Before the controller can start the next attempt or the validator, so a
    // retry always finds this attempt's transcript in the session. Idempotent,
    // so a recovery that sends the signal again commits nothing twice.
    await conversations.settle(current, target.attemptIndex, target.runId);

    const finishReason: FinishReason = reading.result.finishReason;
    const cost = reading.result.costEstimate?.totalCost;
    const payload: GoalAttemptTerminalSignal = {
      finishReason,
      steps: reading.result.steps.length,
      tokens: reading.result.usage.total,
      ...(cost === undefined ? {} : { costUsd: cost }),
    };
    try {
      await durable.engine.signal(
        goalWorkflowId(target.goalRunId),
        goalAttemptTerminalSignalName(target.attemptIndex),
        payload,
        { signalId: attemptSignalId(target.goalRunId, target.attemptIndex) },
      );
    } catch (error) {
      // A controller that ended while the signal was on its way has nothing
      // left to wait for, so that is not a failure to report.
      if (await controllerIsDone(target.goalRunId)) return 'not-needed';
      throw error;
    }
    return 'signal-resent';
  }

  /** The goal ended or was canceled, so no controller is waiting on an attempt. */
  async function controllerIsDone(goalRunId: string): Promise<boolean> {
    const record = await store.get(goalRunId);
    return (
      record === undefined ||
      isTerminalGoalStatus(record.status) ||
      record.cancellation !== undefined
    );
  }

  function track<T>(work: Promise<T>): Promise<T> {
    sending.add(work);
    const release = (): void => {
      sending.delete(work);
    };
    void work.then(release, release);
    return work;
  }

  /** Waits for the attempt's run to end by whatever means this process has. */
  async function untilEnded(target: AttemptTarget, live: AgentRun<unknown, boolean> | undefined) {
    try {
      // The live handle settles on operative's own event, which is not proof the
      // engine's terminal write has committed, so it is never trusted alone: the
      // engine's handle is awaited as well. The run is durably started by the
      // time anything is watched, so the engine has a workflow to hand back.
      if (live !== undefined) await live.result();
      await getDurable()?.engine.getHandle(target.runId).result();
    } catch {
      // A cancelled, failed, or timed-out workflow rejects its handle; its
      // stored state, read next, says which.
    }
  }

  /**
   * The pauses in flight: how to end each one early, and the watcher that is
   * waiting in it. A pause is the one place a watcher sits on a timer of its
   * own, so it is the one place `drain()` can release.
   */
  const paused = new Map<() => void, Promise<void>>();

  /**
   * Waits `delay` milliseconds on the runtime's timers, or until `drain()`
   * releases it; it does not wait at all once the bureau is closing. A pause that is released clears its timer, so it neither
   * outlives shutdown nor, under a manual runtime that never fires one, waits
   * forever.
   */
  const pause = (delay: number, watcher: Promise<void>): Promise<void> =>
    new Promise<void>((resolve) => {
      // A watcher whose send was in flight when shutdown began reaches its next
      // pause after `drain()` took its snapshot of the pauses. A timer armed now
      // would be one nothing releases, and under a manual runtime one that never
      // fires, so a closing bureau arms none.
      if (isClosing()) {
        resolve();
        return;
      }
      const handle = runtime.timers.setTimeout(release, delay);
      function release(): void {
        runtime.timers.clearTimeout(handle);
        paused.delete(release);
        resolve();
      }
      paused.set(release, watcher);
    });

  /**
   * How long to wait before reattaching to a run that is still going after its
   * wait ended: the retry delays again, the last one repeating. The delay is
   * bounded; the number of reattachments is not, since a count would end the
   * watch while the run is alive and leave its controller parked with no one to
   * signal it until the next boot.
   */
  const reattachDelay = (round: number): number =>
    retryDelaysMs[Math.min(round, retryDelaysMs.length - 1)] ?? 0;

  function watch(target: AttemptTarget, live?: AgentRun<unknown, boolean>): void {
    if (watching.has(target.runId)) return;
    let finished!: () => void;
    const ended = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const task = (async (): Promise<void> => {
      let handle = live;
      // A wait on the run can end while the run has not: the engine's handle
      // rejects on a transient persistence fault, and a successful `forward()`
      // then reads the run as not yet terminal. Either way nothing else would
      // signal the controller, so the watch goes on until the run actually ends.
      for (let round = 0; ; round += 1) {
        await untilEnded(target, handle);
        handle = undefined;
        if (isClosing()) return;
        if ((await forwardWithRetries(target, ended)) !== 'watching') return;
        await pause(reattachDelay(round), ended);
        if (isClosing()) return;
      }
    })().finally(() => {
      watching.delete(target.runId);
      finished();
    });
    watching.set(target.runId, task);
  }

  /**
   * Forwards the attempt's ending, retrying a failure with backoff. The
   * controller waits on this signal with no deadline of its own, and recovery
   * runs only at boot, so a failure is retried for as long as the attempt is
   * watched: the configured delays first, then the last one repeating. A count
   * would end the only watcher while the controller is still parked on a
   * dependency that may come back in a minute or an hour. The failure is
   * diagnosed once, when the configured retries are spent, and every pause is
   * one `drain()` can release. `done` once it was sent, found nothing to send,
   * or the bureau is closing.
   */
  async function forwardWithRetries(
    target: AttemptTarget,
    watcher: Promise<void>,
  ): Promise<'done' | 'watching'> {
    let reported = false;
    for (let retry = 0; ; retry += 1) {
      try {
        const outcome = await track(forward(target));
        return outcome === 'watching' ? 'watching' : 'done';
      } catch (error) {
        if (isClosing()) return 'done';
        if (retry >= retryDelaysMs.length && !reported) {
          reported = true;
          diagnose({
            level: 'error',
            scope: 'goals',
            message: `[bureau] Could not forward the end of attempt ${target.attemptIndex} of goal "${target.goalRunId}"; still retrying, and recovery sends it again if this process ends first: ${describe(error)}`,
            cause: error,
          });
        }
        // With no delays configured there is nothing to repeat: the failure is
        // reported and left to recovery.
        if (retryDelaysMs.length === 0) return 'done';
        await pause(reattachDelay(retry), watcher);
        if (isClosing()) return 'done';
      }
    }
  }

  async function reconcile(target: AttemptTarget): Promise<AttemptReconciliation> {
    const outcome = await track(forward(target));
    if (outcome === 'watching') watch(target);
    return outcome;
  }

  /**
   * Resolves once every send already under way has finished, and releases every
   * watcher paused between tries. It does not wait on a running attempt: a watcher
   * waiting on its run is the run's to end.
   *
   * Releasing is what lets shutdown leave nothing of the goal's running. A paused
   * watcher holds a timer, and under a manual runtime one that never fires. Each
   * pause is cut short once: a watcher that finds the bureau closing ends, and
   * its end is awaited; one that does not (cleanup before closing a goal) simply
   * tries again sooner, which is harmless because every try is idempotent. The
   * pauses the released watchers go on to make are not released again, so this
   * cannot chase a watcher round a loop.
   */
  async function drain(): Promise<void> {
    const released = [...paused];
    for (const [release] of released) release();
    if (isClosing()) await Promise.allSettled(released.map(([, watcher]) => watcher));
    while (sending.size > 0) await Promise.allSettled(sending);
  }

  return { watch, reconcile, drain };
}
