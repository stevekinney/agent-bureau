import { createDefaultRuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import type { ConversationHistory } from 'conversationalist';
import { createConversationHistory } from 'conversationalist';

import type { AgentSession } from '../agent-session';
import { createAgentSession } from '../agent-session';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import type { OperativeEventMap } from '../events';
import {
  SessionCancelEvent,
  SessionForkEvent,
  SessionQueryEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
} from '../events';
import type { Subscription } from '../liveness';
import type { CleanupAcknowledgement, ClosedOptions } from '../types';
import {
  historyOrEmpty,
  newestRunningRunRef,
  reconcileTerminalRunRef,
} from './session-handle-support';
import type {
  SessionHandle,
  SessionHandleContext,
  SessionLivenessSnapshot,
} from './session-handle-types';
import {
  ForkThroughRunError,
  NoDurableEngineError,
  NoRunningRunError,
} from './session-handle-types';
import { createSessionLiveness, type LivenessSubscriberRecord } from './session-liveness';
import { createSessionMonitor } from './session-monitor';
import { createSessionRecovery } from './session-recovery';
import { createSessionRun, type SessionRunState } from './session-run';

export * from './session-handle-types';

/**
 * Parse an ISO-8601 duration into milliseconds. Supports hours, minutes and
 * seconds; unrecognized strings fall back to zero.
 */
function parseDuration(iso: string): number {
  const match = /^PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(iso);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function processLocalAbortError(): DOMException {
  return new DOMException('The process-local session timer was aborted', 'AbortError');
}

function processLocalDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
  setTimeoutFunction: (callback: () => void, milliseconds: number) => unknown,
  clearTimeoutFunction: (timer: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timerState: { value?: unknown } = {};
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timerState.value !== undefined) clearTimeoutFunction(timerState.value);
      signal?.removeEventListener('abort', onAbort);
      reject(processLocalAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    timerState.value = setTimeoutFunction(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (settled) {
      clearTimeoutFunction(timerState.value);
    } else if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * Creates a live `SessionHandle` for the given session id.
 *
 * The handle loads-or-creates the session lazily (on first `run()` or
 * `getSession()`). Multiple calls to `createSessionHandle` with the same
 * `sessionId` are safe — each creates an independent handle backed by the same
 * persistent store. Concurrent `run()` calls on the SAME handle are not safe
 * (the handle is NOT thread-safe).
 */
export function createSessionHandle(
  sessionId: string,
  context: SessionHandleContext,
): SessionHandle {
  const { store, engine, checkpointStore, agentName, runOptions } = context;
  const emitter = context.emitter ?? new TypedEventTarget<OperativeEventMap>();
  // AB-92/AB-252/AB-253: resolved exactly once, here, at construction.
  // `setTimeoutFunction`/`clearTimeoutFunction` keep their exported names and
  // documented process-local meaning — an explicit caller-supplied pair still
  // wins — but their defaults now resolve from `runtime.timers` rather than
  // from `globalThis.setTimeout`/`clearTimeout` directly, generalizing the
  // seam onto the composed `RuntimeServices` instead of leaving it as a
  // second, competing injection point.
  const runtime = context.runtime ?? createDefaultRuntimeServices();
  const setTimeoutFunction = context.setTimeoutFunction ?? runtime.timers.setTimeout;
  const clearTimeoutFunction = context.clearTimeoutFunction ?? runtime.timers.clearTimeout;

  /**
   * The currently-in-flight `AgentRun`, if any. Set at `run()` start, cleared
   * when the run settles. Used by `recover()`.
   */
  const sessionRunState: SessionRunState = { currentRun: null, currentRunId: null };

  // ---------------------------------------------------------------------
  // Liveness (AB-88/AB-214/AB-215 — obs-02).
  //
  // `livenessClock` threads the SAME `setTimeoutFunction`/`clearTimeoutFunction`
  // pair already used by `sleep()`/`monitor()`'s inter-tick delay into
  // `createStallWatchdog`'s `clock` parameter — no second timer seam is
  // added. `now()` reads the composed `runtime.monotonic` clock (AB-253),
  // generalizing AB-214's own `realClock` onto the injectable seam: a test
  // drives `missedPulseCount` by manually invoking the captured
  // `setTimeoutFunction` callback, which increments by at least one full
  // missed interval regardless of how little (manual-runtime) time has
  // elapsed (`watchdog.ts`'s `Math.max(1, …)` floor), so a fixed/manual
  // `now()` does not itself prevent the injected clock from driving the
  // watchdog.
  // ---------------------------------------------------------------------
  const liveness = createSessionLiveness({
    sessionId,
    runtime,
    setTimeoutFunction,
    clearTimeoutFunction,
  });
  const {
    livenessSubscribers,
    livenessClock,
    readLivenessSnapshot,
    setLivenessState,
    pauseSessionWatchdogForWait,
    resumeSessionWatchdogAfterWait,
    getWatchdog,
    setWatchdog,
    setWatchdogCadence,
    advanceLiveness,
  } = liveness;

  /**
   * Load the session from the store, creating it if absent.
   */
  async function loadOrCreate(): Promise<AgentSession> {
    const existing = await store.load(sessionId);
    if (existing) return existing;

    return (await store.update(
      sessionId,
      (latest) =>
        latest ??
        createAgentSession({
          agentName,
          conversationHistory: createConversationHistory(),
          id: sessionId,
          runtime,
        }),
    )) as AgentSession;
  }

  /**
   * Require a durable engine or throw `NoDurableEngineError`.
   */
  function requireEngine(verb: string): RegistryAgnosticEngine {
    if (!engine) throw new NoDurableEngineError(verb);
    return engine;
  }

  /**
   * Load the session and return this handle's run when attached, otherwise the
   * last run. Signal/update must not target a later concurrent run owned by
   * another handle.
   */
  async function requireRunningRunId(verb: string): Promise<string> {
    const session = await store.load(sessionId);
    if (sessionRunState.currentRun !== null && sessionRunState.currentRunId === null) {
      throw new NoRunningRunError(verb, sessionId);
    }
    const target = sessionRunState.currentRunId
      ? session?.runs.find((runRef) => runRef.runId === sessionRunState.currentRunId)
      : newestRunningRunRef(session);
    if (!target || target.status !== 'running') {
      throw new NoRunningRunError(verb, sessionId);
    }
    return target.runId;
  }

  const run = createSessionRun({
    sessionId,
    store,
    engine,
    checkpointStore,
    agentName,
    runOptions,
    runtime,
    state: sessionRunState,
    setLivenessState,
    livenessClock,
    pauseSessionWatchdogForWait,
    resumeSessionWatchdogAfterWait,
  });

  const handle: SessionHandle = {
    id: sessionId,

    emitter,

    closed(options?: ClosedOptions): Promise<CleanupAcknowledgement> {
      // Scoped to what this handle itself tracks (AB-210): `not-required`
      // when nothing is live, otherwise delegate to the live run's own
      // `closed()` — its identical returned object satisfies the "delegate
      // and return the same object" acceptance criterion for free.
      if (sessionRunState.currentRun === null) {
        return Promise.resolve({ status: 'not-required' });
      }
      return sessionRunState.currentRun.closed(options);
    },

    run,
    recover: createSessionRecovery({
      sessionId,
      store,
      engine,
      checkpointStore,
      runOptions,
      emitter,
      state: sessionRunState,
    }),
    async cancel(): Promise<void> {
      // Step 1: Abort the in-process generate signal IMMEDIATELY (stops the
      // provider connection → stops billing). This is the "load-bearing" abort
      // path from architecture.md: we do NOT rely on Weft termination reaching
      // the in-flight call, because Weft only honors cancel at the next `yield*`.
      const currentRun = sessionRunState.currentRun;
      const targetRunId = sessionRunState.currentRunId;
      if (currentRun) {
        currentRun.abort('cancelled');
      }

      // Request durable cancellation after signalling the attached run.
      // Engine failures remain non-fatal; load the session once and reuse.
      const cancelSession = await store.load(sessionId);
      const targetRun = targetRunId
        ? cancelSession?.runs.find((runRef) => runRef.runId === targetRunId)
        : currentRun
          ? undefined
          : newestRunningRunRef(cancelSession);
      const cancelRunId = targetRun?.runId ?? targetRunId;

      // Emit the cancel event with the targeted run id (null if no runs recorded yet).
      emitter.dispatchEvent(new SessionCancelEvent(sessionId, cancelRunId ?? null));

      if (engine && cancelSession) {
        if (targetRun && targetRun.status === 'running') {
          try {
            await engine.cancel(targetRun.runId);
            // An attached run owns its atomic transcript/outcome commit. A
            // detached cancellation reconciles the actual durable terminal state.
            if (!currentRun) {
              await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, targetRun);
            }
          } catch {
            // Preserve cancellation's non-throwing engine/reconciliation contract.
          }
        }
      }

      if (
        sessionRunState.currentRun === currentRun &&
        sessionRunState.currentRunId === targetRunId
      ) {
        sessionRunState.currentRun = null;
        sessionRunState.currentRunId = null;
      }
    },

    async fork(options?: { throughRun?: number }): Promise<SessionHandle> {
      const session = await loadOrCreate();

      // Default: fork through the last run.
      const lastRunIndex = session.runs.length - 1;
      const throughSequence = options?.throughRun ?? lastRunIndex;

      // Guard: without per-run conversation snapshots, forking before the last
      // run would copy the FULL stored conversationHistory (which reflects all
      // completed runs), contaminating the branch with messages after the
      // requested fork point. Reject non-default throughRun values that point
      // before the last run until Phase D lands per-run snapshots.
      if (options?.throughRun !== undefined && options.throughRun < lastRunIndex) {
        throw new ForkThroughRunError(options.throughRun, lastRunIndex);
      }

      // Copy the conversation history. The session's stored conversationHistory
      // is the authoritative snapshot of all completed runs. When throughRun is
      // at (or after) the last run, this is exactly the right history to copy.
      const forkedHistory: ConversationHistory = historyOrEmpty(
        session.conversationHistory,
        runtime,
      );

      // Create the forked session with a new id and empty runs[].
      const newSessionId = runtime.identifiers.next('session');
      const forkedSession = createAgentSession({
        agentName: session.agentName,
        conversationHistory: forkedHistory,
        id: newSessionId,
        runs: [],
        runtime,
      });
      await store.save(forkedSession);

      // throughSequence is used conceptually to bound the fork point; full
      // per-run snapshot support (Phase D) will use it to reconstruct history
      // at exactly that boundary. For now it is always === lastRunIndex.
      void throughSequence;

      // Emit after the forked session is persisted so the id is stable.
      emitter.dispatchEvent(new SessionForkEvent(sessionId, newSessionId, options?.throughRun));

      return createSessionHandle(newSessionId, context);
    },

    async sleep(duration: number | string, options?: { signal?: AbortSignal }): Promise<void> {
      const ms = typeof duration === 'number' ? duration : parseDuration(duration);

      // Reject string durations that parsed to 0 ms — same guard as
      // `monitor({ every })`. parseDuration returns 0 for unrecognised strings
      // (e.g. '5m' instead of 'PT5M'); silently sleeping 0 ms would resume the
      // session immediately instead of pausing for the caller's intended delay.
      if (typeof duration === 'string' && ms === 0) {
        throw new Error(
          `session.sleep() received an invalid duration string: "${duration}". ` +
            `Use a number (milliseconds) or an ISO-8601 PT duration such as 'PT5M' or 'PT1H30M'.`,
        );
      }

      if (options?.signal?.aborted) throw processLocalAbortError();
      emitter.dispatchEvent(new SessionSleepEvent(sessionId, ms));
      await processLocalDelay(ms, options?.signal, setTimeoutFunction, clearTimeoutFunction);
    },

    async signal(name: string, payload?: unknown): Promise<void> {
      const eng = requireEngine('signal');
      const runId = await requireRunningRunId('signal');
      emitter.dispatchEvent(new SessionSignalEvent(sessionId, runId, name, payload));
      await eng.signal(runId, name, payload);
      // Liveness (AB-215): a matching signal releases this session's
      // 'signal'/'review' declared wait (AB-88's unbounded-wait exception).
      // Resuming the watchdog with a FRESH instance discards the paused
      // interval entirely rather than letting it read as a burst of missed
      // pulses now that assessment resumes.
      if (sessionRunState.parkedRunId === runId && sessionRunState.parkedSignalName === name) {
        sessionRunState.parkedRunId = undefined;
        sessionRunState.parkedSignalName = undefined;
        resumeSessionWatchdogAfterWait();
        setLivenessState('running');
      }
    },

    async update<TResult = unknown>(name: string, payload?: unknown): Promise<TResult> {
      const eng = requireEngine('update');
      const runId = await requireRunningRunId('update');
      emitter.dispatchEvent(new SessionUpdateEvent(sessionId, runId, name, payload));
      return eng.update(runId, name, payload) as Promise<TResult>;
    },

    async query<TResult = unknown>(name: string, input?: unknown): Promise<TResult> {
      const eng = requireEngine('query');
      // `query` works on any session (full fidelity when a live run is attached,
      // durable fidelity from the checkpoint otherwise). Prefer this handle's
      // attached run; fall back to the last run when no run is attached.
      const session = await store.load(sessionId);
      if (sessionRunState.currentRun !== null && sessionRunState.currentRunId === null) {
        throw new NoRunningRunError('query', sessionId);
      }
      const target = sessionRunState.currentRunId
        ? session?.runs.find((runRef) => runRef.runId === sessionRunState.currentRunId)
        : (newestRunningRunRef(session) ?? session?.runs[session.runs.length - 1]);
      if (!target) {
        throw new NoRunningRunError('query', sessionId);
      }
      emitter.dispatchEvent(new SessionQueryEvent(sessionId, name, input));
      return eng.query(target.runId, name, input) as Promise<TResult>;
    },

    monitor: createSessionMonitor({
      sessionId,
      emitter,
      runtime,
      livenessClock,
      setTimeoutFunction,
      clearTimeoutFunction,
      run,
      setLivenessState,
      processLocalDelay: (ms, signal) =>
        processLocalDelay(ms, signal, setTimeoutFunction, clearTimeoutFunction),
      processLocalAbortError,
      parseDuration,
      getWatchdog,
      setWatchdog,
      setWatchdogCadence,
      advanceLiveness,
    }),

    async getSession(): Promise<AgentSession> {
      return loadOrCreate();
    },

    snapshot(): SessionLivenessSnapshot {
      return readLivenessSnapshot();
    },

    subscribeSnapshot(
      observer: (snapshot: SessionLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      const abortSignal = subscribeOptions?.signal;
      const record: LivenessSubscriberRecord = {
        observer,
        closed: false,
        detach: () => abortSignal?.removeEventListener('abort', unsubscribe),
      };

      function unsubscribe(): void {
        if (record.closed) return;
        record.closed = true;
        record.detach();
        livenessSubscribers.delete(record);
      }

      // A session never reaches a terminal liveness status — it can always
      // accept another `run()` — so, unlike `active-run-liveness.ts`, there
      // is no already-terminal fast path; only an already-aborted signal
      // short-circuits to a single synchronous delivery.
      if (abortSignal?.aborted) {
        record.closed = true;
        try {
          observer(readLivenessSnapshot());
        } catch {
          // Same isolation as `notifyLiveness()` above.
        }
        return {
          unsubscribe,
          get closed() {
            return record.closed;
          },
        };
      }

      // Register BEFORE the synchronous initial delivery — mirrors
      // `active-run-liveness.ts`'s identical reentrancy guard: an observer
      // that itself synchronously triggers a revision change must still be
      // registered when that notification runs.
      livenessSubscribers.add(record);
      abortSignal?.addEventListener('abort', unsubscribe, { once: true });

      try {
        observer(readLivenessSnapshot());
      } catch {
        // Same isolation as `notifyLiveness()` above.
      }

      return {
        unsubscribe,
        get closed() {
          return record.closed;
        },
      };
    },
  };

  return handle;
}
