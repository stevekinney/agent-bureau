import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { RuntimeServices } from 'lifecycle';
import { CompletableEventTarget, ForwardedEvent } from 'lifecycle';

import type { AgentRun, RunEvent } from '../agent-run';
import { createAgentRun } from '../agent-run';
import type { RunRef } from '../agent-session';
import { createAgentSession } from '../agent-session';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import { createActiveRun } from '../create-run';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import type { CombinedOperativeEventMap } from '../events';
import { HumanWaitParkedEvent } from '../events';
import type {
  AgentRunLivenessSnapshot,
  DeclaredWait,
  LivenessLifecycleStatus,
  StallWatchdogClock,
} from '../liveness';
import { LIVENESS_POLICY_VERSION } from '../liveness';
import type { RunResult } from '../types';
import type { SessionRunOptions } from './session-handle';
import { deriveRunId } from './session-handle';
import {
  appendConversationMessages,
  finishReasonToStatus,
  historyOrEmpty,
  isTerminalRunEvent,
  runOutcomeFromResult,
} from './session-handle-support';
import { MissingRunOptionsError } from './session-handle-types';
import type { SessionStore } from './types';
export interface SessionRunState {
  currentRun: AgentRun | null;
  currentRunId: string | null;
  thisRunId?: string;
  parkedRunId?: string;
  parkedSignalName?: string;
}
export interface SessionRunDependencies {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly engine: RegistryAgnosticEngine | undefined;
  readonly checkpointStore: CheckpointStore | undefined;
  readonly agentName: string;
  readonly runOptions: SessionRunOptions | undefined;
  readonly runtime: RuntimeServices;
  readonly state: SessionRunState;
  readonly setLivenessState: (next: LivenessLifecycleStatus, wait?: DeclaredWait) => void;
  readonly livenessClock: StallWatchdogClock;
  readonly pauseSessionWatchdogForWait: () => void;
  readonly resumeSessionWatchdogAfterWait: () => void;
}
export function createSessionRun(
  dependencies: SessionRunDependencies,
): (input: string) => AgentRun {
  const {
    sessionId,
    store,
    engine,
    checkpointStore,
    agentName,
    runOptions,
    runtime,
    state,
    setLivenessState,
    livenessClock,
    pauseSessionWatchdogForWait,
    resumeSessionWatchdogAfterWait,
  } = dependencies;
  return (input: string): AgentRun => {
    if (!runOptions) throw new MissingRunOptionsError();
    const configuredRunOptions = runOptions;
    // A shared emitter that bridges the outer ActiveRun surface (returned
    // synchronously) with the real inner run's events (created after session
    // load). Events dispatched by the inner ActiveRun are forwarded here so
    // for-await on the returned AgentRun sees them.
    const outerEmitter = new CompletableEventTarget<CombinedOperativeEventMap>();

    // An AbortController created eagerly so abort() works immediately, even
    // before the inner run is created. Its signal is threaded into RunOptions
    // so the actual generate call sees it and drops the provider connection
    // promptly when cancelled. This is the "load-bearing abort" path that
    // stops billing — it must be synchronous and must not wait for
    // loadOrCreate() to complete.
    const abortController = new AbortController();

    // Captured once `innerRun` is created inside `resultPromise`. Used by
    // `activeRunWrapper.abort()` to forward the abort to the inner run so
    // that, on the durable path, `engine.cancel()` is also called — which is
    // the only way to stop a workflow that is parked in `ctx.sleep` or
    // `ctx.waitForSignal`. The abort signal alone is insufficient because Weft
    // only sees the signal on the *next yield*, not while the workflow is
    // suspended at a durable step.
    let activeInnerRun: ActiveRun | null = null;

    // This call's own run id, once the reservation resolves — used to
    // correlate a `HumanWaitParkedEvent` and to clean up park bookkeeping
    // when this run settles (liveness, AB-215).

    // Eagerly reflect this run as the session's own current activity.
    // Clears any leftover declared wait from a prior run.
    setLivenessState('running');

    const resultPromise: Promise<RunResult> = (async () => {
      let reservation:
        | {
            runId: string;
            userMessageId: string;
            baseConversationHistory: ConversationHistory;
            seededConversation: Conversation;
          }
        | undefined;

      // Reserve the sequence/runId and persist the 'running' RunRef in one
      // conflict-aware update. This is the point where concurrent handles must
      // serialize so they cannot both choose the same sequence number.
      await store.update(sessionId, (existing) => {
        const session =
          existing ??
          createAgentSession({
            agentName,
            // AB-321: forwards the resolved runtime into the seeded
            // ConversationHistory's own environment seam.
            conversationHistory: createConversationHistory(undefined, { runtime }),
            id: sessionId,
            runtime,
          });
        const sequence = session.runs.length;
        const runId = deriveRunId(sessionId, sequence);
        const baseConversationHistory = session.conversationHistory;
        // AB-321: forwards the resolved runtime — only relevant when
        // `session.conversationHistory` is genuinely empty and this
        // constructor mints a fresh default; otherwise `historyOrEmpty`'s
        // existing history's id is preserved either way.
        const seededConversation = new Conversation(
          historyOrEmpty(session.conversationHistory, runtime),
          { runtime },
        );
        seededConversation.appendUserMessage(input);
        const userMessageId = seededConversation.current.ids.at(-1);
        if (!userMessageId) {
          throw new Error(`Failed to identify the user message for run "${runId}".`);
        }
        const runningRef: RunRef = {
          runId,
          sequence,
          status: 'running',
          startedAt: runtime.clock.nowISO(),
          agentName,
          userMessageId,
        };

        reservation = {
          runId,
          userMessageId,
          baseConversationHistory,
          seededConversation,
        };

        return {
          ...session,
          runs: [...session.runs, runningRef],
        };
      });

      if (!reservation) {
        throw new Error(`Failed to reserve a run for session "${sessionId}".`);
      }

      const { runId, userMessageId, baseConversationHistory, seededConversation } = reservation;
      state.currentRunId = runId;
      state.thisRunId = runId;

      // Thread the eager AbortController's signal into the run options so
      // abort() works immediately — even before the inner run's own
      // AbortController is created (inside createActiveRun). When the caller
      // aborts via agentRun.abort(), abortController.abort() fires and the
      // combinedSignal inside the run loop drops the provider connection.
      const runOptionsWithSignal = {
        ...configuredRunOptions,
        agentName,
        // Stamp the derived runId so tool.* bubble events (ToolStartedBubbleEvent,
        // ToolSettledBubbleEvent, etc.) carry the session run's stable id on the
        // in-memory path. Without this, createActiveRun falls back to runId=''
        // because options.runId is undefined (the durable path gets runId via
        // DurableRunRouting instead, so this is safe to include on both paths).
        runId,
        conversation: seededConversation.current,
        signal: configuredRunOptions.signal
          ? AbortSignal.any([configuredRunOptions.signal, abortController.signal])
          : abortController.signal,
        // AB-253: an explicit `runOptions.runtime` still wins; otherwise every
        // run() this session dispatches shares the SAME composed runtime the
        // handle itself was constructed with, so a session driven by a manual
        // runtime stays deterministic end-to-end rather than each run minting
        // its own default (real-globals) instance.
        runtime: configuredRunOptions.runtime ?? runtime,
      };

      // Route through the durable engine when both engine and checkpointStore
      // are present, so the run is checkpointed and reachable via
      // signal/update/query/recover() using the derived runId.
      const innerRun: ActiveRun =
        engine && checkpointStore
          ? createActiveRun(runOptionsWithSignal, { engine, checkpointStore, runId, sessionId })
          : createActiveRun(runOptionsWithSignal);

      // Expose the inner run so `activeRunWrapper.abort()` can forward to it.
      // Set here (after inner run creation, before awaiting its result) so
      // that any abort() called while the run is in progress reaches the
      // inner run and triggers engine.cancel(). An abort() that races with
      // loadOrCreate (before this assignment) still fires the AbortController
      // (stopping the in-flight generate), but engine.cancel is only
      // reachable once this reference is live.
      activeInnerRun = innerRun;

      // Forward all inner events to the outer emitter so for-await consumers
      // see the full event stream.
      const pendingTerminalEvents: RunEvent[] = [];
      const subscription = innerRun.toObservable().subscribe({
        next: (e) => {
          if (isTerminalRunEvent(e)) {
            pendingTerminalEvents.push(e);
          } else {
            outerEmitter.dispatchEvent(e);
          }
          // A `requestHumanInput` tool typically dispatches via its
          // `RuntimeToolContext.dispatch`, which lands on the toolbox's
          // own event target and reaches this run's emitter wrapped as a
          // `ForwardedEvent` (`toolbox-event-forwarding.ts`) — unwrap it
          // so a `HumanWaitParkedEvent` is recognized either way (a bare
          // dispatch onto a run-level emitter, or the toolbox-forwarded
          // path used today).
          const humanWait =
            e instanceof HumanWaitParkedEvent
              ? e
              : e instanceof ForwardedEvent && e.originalEvent instanceof HumanWaitParkedEvent
                ? e.originalEvent
                : undefined;
          // AB-88: 'review' and 'signal' are distinct DeclaredWaitReasons
          // even though both surface through `human-wait.parked` today —
          // a supplied `prompt` (requestHumanInput's reviewer-facing text)
          // distinguishes a human review from a bare external signal.
          // Deadline is intentionally omitted: both reasons are legal
          // unbounded waits (AB-88's unbounded-wait exception), so the
          // session watchdog is paused rather than left to accrue missed
          // pulses purely from elapsed time.
          if (humanWait && humanWait.runId === runId) {
            state.parkedRunId = runId;
            state.parkedSignalName = humanWait.signalName;
            pauseSessionWatchdogForWait();
            setLivenessState('waiting', {
              reason: humanWait.prompt !== undefined ? 'review' : 'signal',
              startedAt: livenessClock.now(),
              dependency: humanWait.signalName,
              wakeCondition: `session.signal('${humanWait.signalName}')`,
            });
          }
        },
      });

      let innerResult: RunResult;
      try {
        innerResult = await innerRun.result;
      } catch (err) {
        // Persist infrastructure failure and its originating turn before rejection.
        subscription.unsubscribe();
        try {
          const committedSession = await store.update(sessionId, (freshSession) => {
            if (!freshSession) return undefined;
            const currentRef = freshSession.runs.find((run) => run.runId === runId);
            if (!currentRef) return undefined;
            if (currentRef.status !== 'running') {
              if (
                currentRef.status !== 'error' ||
                (currentRef.outcome?.finishReason !== undefined &&
                  currentRef.outcome.finishReason !== 'error')
              ) {
                throw new Error(`Run "${runId}" has a conflicting terminal classification.`);
              }
            }
            const errorRef: RunRef =
              currentRef.status === 'running'
                ? { ...currentRef, status: 'error', outcome: { finishReason: 'error' } }
                : currentRef;
            return {
              ...freshSession,
              conversationHistory: appendConversationMessages(
                freshSession.conversationHistory,
                seededConversation.current,
                seededConversation.current,
              ),
              runs: freshSession.runs.map((r) => (r.runId === runId ? errorRef : r)),
            };
          });
          if (committedSession === undefined) {
            throw new Error(
              `Session "${sessionId}" disappeared before run "${runId}" failure committed.`,
              { cause: err },
            );
          }
        } catch (commitError) {
          outerEmitter.complete();
          throw new Error(`Failed to persist terminal failure for run "${runId}".`, {
            cause: commitError,
          });
        }
        outerEmitter.complete();
        throw err;
      }

      subscription.unsubscribe();

      // Replace the 'running' ref with the terminal status. Re-load the
      // session in case a concurrent run completed, but replace by runId
      // rather than appending so the runs[] length stays correct.
      const committedSession = await store.update(sessionId, (freshSession) => {
        if (!freshSession) return undefined;
        const currentRef = freshSession.runs.find((run) => run.runId === runId);
        if (!currentRef) return undefined;
        const alreadyTerminal = currentRef.status !== 'running';
        if (
          alreadyTerminal &&
          (currentRef.status !== finishReasonToStatus(innerResult.finishReason) ||
            (currentRef.outcome?.finishReason !== undefined &&
              currentRef.outcome.finishReason !== innerResult.finishReason))
        ) {
          throw new Error(`Run "${runId}" has a conflicting terminal classification.`);
        }
        const terminalRef: RunRef = alreadyTerminal
          ? currentRef
          : {
              ...currentRef,
              status: finishReasonToStatus(innerResult.finishReason),
              userMessageId,
              outcome: runOutcomeFromResult(innerResult),
            };
        return {
          ...freshSession,
          conversationHistory: appendConversationMessages(
            freshSession.conversationHistory,
            innerResult.conversation.current,
            alreadyTerminal ? innerResult.conversation.current : baseConversationHistory,
          ),
          runs: freshSession.runs.map((r) => (r.runId === runId ? terminalRef : r)),
        };
      });
      if (committedSession === undefined) {
        outerEmitter.complete();
        throw new Error(`Session "${sessionId}" disappeared before run "${runId}" committed.`);
      }

      for (const event of pendingTerminalEvents) outerEmitter.dispatchEvent(event);
      outerEmitter.complete();

      return innerResult;
    })();

    // closed()'s not-required fast path (AB-204) — see the identical flag
    // in create-run.ts / active-run-adapter.ts.
    let cancelRequested = false;

    // Build the ActiveRun surface backed by the outer emitter so createAgentRun
    // can subscribe to events and abort the run.
    const activeRunWrapper: ActiveRun = {
      result: resultPromise,
      // AB-361: this wrapper deliberately leaves `durablyStarted`
      // unset. `SessionHandle` is not `createRunFromRequest`'s durable
      // branch — no caller of this wrapper awaits it — and a forwarding
      // getter here would need to track `activeInnerRun`'s late
      // construction (the reservation step below assigns it) for no
      // current consumer.
      abort(reason?: string): void {
        cancelRequested = true;
        // Always fire the outer AbortController — this cancels the in-flight
        // generate call (stops billing). Then forward to the inner run so that
        // on the durable path `engine.cancel()` is also triggered, stopping
        // any workflow parked in `ctx.sleep` or `ctx.waitForSignal`.
        abortController.abort(reason);
        activeInnerRun?.abort(reason);
      },
      // Delegates to the inner run's own `closed()` once one exists — this
      // wrapper adds no cleanup of its own beyond what `createActiveRun`/
      // `reattachDurableActiveRun` already track for the inner run. If
      // `resultPromise` settles without one ever having been created (the
      // reservation step itself failed), there is nothing else to await.
      closed: createClosedAcknowledgement({
        result: resultPromise,
        // `cancelRequested` alone misses a cancellation delivered through
        // the session's own configured `runOptions.signal` rather than a
        // direct `abort()`/`[Symbol.dispose]()` call — matching the
        // identical fix in create-run.ts / active-run-adapter.ts.
        // `activeInnerRun !== null` disqualifies unconditionally too: once
        // a real inner run exists, its own closed() already correctly
        // implements not-required semantics — this wrapper's OWN fast
        // path applies only to the "reservation itself failed, no inner
        // run ever created" case, never bypassing a real inner run's
        // acknowledgement (which can be unresolved/unreachable even with
        // no cancellation requested — a disposed durable engine mid-run).
        disqualifiesFastPath: () =>
          cancelRequested ||
          abortController.signal.aborted ||
          (configuredRunOptions.signal?.aborted ?? false) ||
          activeInnerRun !== null,
        hasInFlightWork: () => false,
        resolveOutcome: () =>
          activeInnerRun ? activeInnerRun.closed() : Promise.resolve({ status: 'completed' }),
      }),
      addEventListener: outerEmitter.addEventListener.bind(outerEmitter),
      removeEventListener: outerEmitter.removeEventListener.bind(outerEmitter),
      on: outerEmitter.on.bind(outerEmitter),
      once: outerEmitter.once.bind(outerEmitter),
      subscribe: outerEmitter.subscribe.bind(outerEmitter),
      events: outerEmitter.events.bind(outerEmitter) as ActiveRun['events'],
      toObservable: outerEmitter.toObservable.bind(outerEmitter),
      complete: outerEmitter.complete.bind(outerEmitter),
      // SessionHandle's own `LivenessObservable` wiring is AB-89's obs-02
      // slice, out of this issue's delivery boundary. This wrapper is a
      // pass-through proxy to the inner `ActiveRun`'s liveness surface once
      // it exists (after `loadOrCreate` resolves); before that, it reports
      // a synthetic 'created' snapshot rather than throwing, so a caller
      // that calls `snapshot()`/`subscribeSnapshot()` before the reservation
      // completes gets a legal (if uninformative) value.
      snapshot(): AgentRunLivenessSnapshot {
        if (activeInnerRun) return activeInnerRun.snapshot();
        const now = runtime.clock.nowISO();
        return {
          id: state.currentRunId ?? sessionId,
          kind: 'agent-run',
          startedAt: now,
          revision: 0,
          status: 'created',
          lastTransitionAt: now,
          projection: 'redacted',
          ownership: 'independent',
          detached: false,
          durability: 'process-local',
          cancellable: true,
          attempt: 0,
          reachability: 'unknown',
          progress: 'unknown',
          assessment: 'healthy',
          observedAt: runtime.clock.now(),
          missedPulseCount: 0,
          policyVersion: LIVENESS_POLICY_VERSION,
          evidence: [],
        };
      },
      subscribeSnapshot(observer, subscribeOptions) {
        if (activeInnerRun) return activeInnerRun.subscribeSnapshot(observer, subscribeOptions);
        observer(activeRunWrapper.snapshot());
        return { unsubscribe(): void {}, closed: true };
      },
      [Symbol.dispose](): void {
        cancelRequested = true;
        // Mirror abort(): fire the outer AbortController (stops billing) and
        // forward to the inner run so engine.cancel() is also triggered for
        // workflows parked in ctx.sleep or ctx.waitForSignal.
        abortController.abort();
        activeInnerRun?.abort();
        outerEmitter.complete();
      },
    };

    const agentRun = createAgentRun(activeRunWrapper);
    state.currentRun = agentRun;

    // Clear state.currentRun and complete the outer emitter once the run settles.
    void resultPromise
      .catch(() => {
        // Result errors propagate to callers through agentRun.result().
      })
      .finally(() => {
        outerEmitter.complete();
        if (state.currentRun === agentRun) {
          state.currentRun = null;
          state.currentRunId = null;
        }
        // Liveness (AB-215): this run is done. Clear a still-outstanding
        // park (e.g. cancel()/abort() ended the run while parked) so a
        // paused watchdog is not stranded, then reflect the session as
        // idle again — a monitor tick's own pulse/wait overrides this
        // immediately if this run() call was one of its ticks.
        if (state.thisRunId !== undefined && state.parkedRunId === state.thisRunId) {
          state.parkedRunId = undefined;
          state.parkedSignalName = undefined;
          resumeSessionWatchdogAfterWait();
        }
        setLivenessState('created');
      });

    return agentRun;
  };
}
