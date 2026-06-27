import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget, TypedEventTarget } from 'lifecycle';

import type { AgentRun } from '../agent-run';
import { createAgentRun } from '../agent-run';
import type { AgentSession, RunRef } from '../agent-session';
import { createAgentSession } from '../agent-session';
import type { ActiveRun } from '../create-run';
import { createActiveRun } from '../create-run';
import { reattachDurableActiveRun } from '../durable/active-run-adapter';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { AnyRunEngine } from '../durable/create-run-engine';
import type { CombinedOperativeEventMap, OperativeEventMap } from '../events';
import {
  SessionCancelEvent,
  SessionForkEvent,
  SessionMonitorDoneEvent,
  SessionMonitorTickEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
} from '../events';
import type { FinishReason, RunOptions, RunResult } from '../types';
import type { SessionStore } from './types';

/**
 * Terminal finish reasons that represent a FAILED run. `run.result()` resolves
 * (rather than throws) for these, so monitor must check for them explicitly
 * before evaluating its predicate (PRRT_kwDORvupsc6MddwB).
 */
const FAILURE_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  'error',
  'aborted',
  'budget-exceeded',
  'elicitation-denied',
]);

/**
 * Options passed to `createSessionHandle` that define the agent's run behavior.
 * These are the portions of `RunOptions` that are constant across every `run()`
 * call within the session (the LLM backend, toolbox, hooks, limits, etc.).
 */
export type SessionRunOptions = Omit<RunOptions, 'conversation'>;

/**
 * Options for `session.monitor()` — a durable conditional watch loop that runs
 * the agent on a repeating cadence until a predicate is satisfied or a deadline
 * is reached.
 *
 * Each tick fires a new durable `AgentRun` with `input` as the prompt. The
 * `until` predicate receives the completed `RunResult` and returns `true` when
 * the condition is met (ending the loop). If `until` returns `false`, the loop
 * sleeps for `every` milliseconds and starts the next tick.
 *
 * The predicate must NOT be a closure that captures mutable state across ticks
 * — it is evaluated in-process after each run and cannot cross a durable
 * checkpoint boundary. It is a pure function of the run's output.
 */
export interface MonitorOptions {
  /**
   * How long to wait between ticks.
   * Milliseconds (number) or ISO-8601 duration string (e.g. `'PT5M'`, `'PT1H'`).
   */
  every: number | string;

  /**
   * The prompt sent to the agent on each tick.
   */
  input: string;

  /**
   * Predicate evaluated on the completed `RunResult` of each tick.
   * Return `true` to end the loop (condition met). Return `false` to sleep and
   * try again.
   *
   * Must be a pure function of the run result — NOT a closure that captures
   * mutable state across ticks (such state cannot survive a durable checkpoint).
   */
  until: (result: RunResult) => boolean;

  /**
   * Optional deadline guard. The monitor loop will stop and return `false` (not
   * met) when the total elapsed time exceeds this value.
   * Milliseconds (number) or ISO-8601 duration string (e.g. `'PT24H'`).
   */
  maxDuration?: number | string;
}

/**
 * The live handle returned by `agent.session(id)` / `bureau.session(id)`.
 * Owns an ordered `runs[]` sequence and exposes the full lifecycle verb set
 * described in `architecture.md § Run ↔ session identity`.
 */
export interface SessionHandle {
  /** Stable session id. */
  readonly id: string;

  /**
   * Start a new run in the session (conversation continuation). Always appends a
   * new `RunRef` to `runs[]` when it completes. Returns an `AgentRun` handle
   * (non-thenable — consume via `for await` or `.result()`).
   *
   * `runId` is DERIVED: `${sessionId}:${sequence}` — the caller never supplies it.
   */
  run(input: string): AgentRun;

  /**
   * Re-attach to the last run IFF it is non-terminal (`status === 'running'`).
   *
   * **In-process path (no engine or run is live):** returns the in-process
   * `AgentRun` handle immediately when a run is currently executing in this
   * process, otherwise `null`.
   *
   * **Durable re-attach path (engine present + last run `status: 'running'` in
   * the store):** after a crash → restart, the bureau re-creates an engine over
   * the same store and Weft's `recoverAll()` resumes in-flight workflows on boot.
   * `recover()` then reads the session's `runs.at(-1)`, derives the `runId`, calls
   * `engine.resume(runId)` to get the already-running recovered handle, wraps it
   * in an `AgentRun`, and sets it as the live `currentRun` so subsequent calls
   * to `recover()` return the same handle without another engine call.
   *
   * Returns `null` when there is no in-flight run to reattach to (disconnect =
   * keep going; this is NOT "resume from the last message").
   *
   * Over HTTP: a client reconnecting after a network drop calls `recover()` to
   * re-subscribe to the in-flight run's event stream.
   */
  recover(): Promise<AgentRun | null>;

  /**
   * Deliberate stop — abort the `generate` `AbortController` IMMEDIATELY (stops the
   * provider call and stops billing), AND terminate the Weft workflow in parallel
   * (stops the next step from starting). Does NOT rely on Weft termination reaching
   * the in-flight call.
   *
   * "Disconnect ≠ stop" is resolved by having both `recover()` (keep going) and
   * `cancel()` (deliberate stop) as distinct verbs.
   */
  cancel(): Promise<void>;

  /**
   * Branch the session: copy conversation history through run `throughRun` (a
   * sequence integer, 0-based) into a fresh session with a new id. The fork starts
   * with `runs: []`. In-flight source work is NOT captured.
   *
   * `throughRun` defaults to the index of the last run in `runs[]`.
   */
  fork(options?: { throughRun?: number }): Promise<SessionHandle>;

  /**
   * Durable pause of the session. Requires a durable engine. Without an engine
   * this falls back to a simple async sleep on the in-memory path.
   *
   * @param duration - Milliseconds (number) or an ISO-8601 duration string
   *   (e.g. `'PT30S'`, `'PT1H'`).
   */
  sleep(duration: number | string): Promise<void>;

  /**
   * Fire-and-forget signal into the in-flight run's workflow. The agent loop's
   * `ctx.waitForSignal` consumes it. Releases parked HITL waits. Requires a
   * durable engine and a currently-running run.
   */
  signal(name: string, payload?: unknown): Promise<void>;

  /**
   * Validated request/response mutation of the running session's workflow state.
   * Returns the handler's result. Requires a durable engine and a running run.
   */
  update<TResult = unknown>(name: string, payload?: unknown): Promise<TResult>;

  /**
   * Read-only live introspection of the running session (full fidelity when a
   * run is attached, durable fidelity otherwise). Requires a durable engine.
   */
  query<TResult = unknown>(name: string, input?: unknown): Promise<TResult>;

  /**
   * Run the agent on a repeating cadence until a predicate is satisfied or a
   * deadline is reached.
   *
   * Each tick:
   * 1. Executes a full agent run with `options.input` as the prompt.
   * 2. Evaluates `options.until(runResult)`.
   * 3. If `true`, the loop exits and this method resolves `true`.
   * 4. If `false`, sleeps `options.every` milliseconds, then repeats.
   *
   * If `options.maxDuration` is set and the total elapsed time exceeds it
   * before the predicate is satisfied, the loop exits and this method resolves
   * `false`.
   *
   * Emits `session.monitor.tick` on each tick start and `session.monitor.done`
   * on completion (C3 completeness rule — every state transition emits an event).
   *
   * @returns `true` when the condition was met; `false` when the deadline was
   * reached before the condition was satisfied.
   */
  monitor(options: MonitorOptions): Promise<boolean>;

  /** Load the persisted session data from the store. */
  getSession(): Promise<AgentSession>;

  /**
   * The event emitter for session-scoped events (session.recover,
   * session.cancel, session.fork, session.sleep, session.signal,
   * session.update, session.query). Subscribe here to observe session
   * verb transitions without waiting for an active run.
   */
  readonly emitter: TypedEventTarget<OperativeEventMap>;
}

/**
 * Context injected into `createSessionHandle`.
 */
export interface SessionHandleContext {
  /** The session store used to load/save the session data. */
  store: SessionStore;
  /**
   * The durable Weft engine, present when the bureau has `.persistence()`.
   * When absent, `signal`/`update`/`query` throw `NoDurableEngineError`.
   * Required alongside `checkpointStore` for the durable `recover()` re-attach
   * path (D2).
   */
  engine?: AnyRunEngine;
  /**
   * The checkpoint store for reading durable run transcripts. Required for the
   * durable `recover()` re-attach path (D2) when `engine` is present. If absent
   * while `engine` is set, `recover()` degrades to in-process-only.
   */
  checkpointStore?: CheckpointStore;
  /**
   * The agent name, stored on the session record.
   */
  agentName: string;
  /**
   * The constant run behavior (generate fn, toolbox, hooks, etc.) for every
   * `run()` call in this session.
   */
  runOptions: SessionRunOptions;
  /**
   * Optional event emitter for session-scoped events (session.recover,
   * session.cancel, session.fork, session.sleep, session.signal,
   * session.update, session.query). When provided, each verb method
   * dispatches the corresponding typed event. Created internally if omitted.
   */
  emitter?: TypedEventTarget<OperativeEventMap>;
}

/**
 * Thrown when a durable verb (`signal`/`update`/`query`) is called on a session
 * that has no durable engine.
 */
export class NoDurableEngineError extends Error {
  readonly code = 'NoDurableEngineError';

  constructor(verb: string) {
    super(
      `session.${verb}() requires a durable engine (.persistence() on the bureau). ` +
        `This session is in-memory only.`,
    );
    this.name = 'NoDurableEngineError';
  }
}

/**
 * Thrown when a durable verb that requires an in-flight run is called but no
 * run is currently running.
 */
export class NoRunningRunError extends Error {
  readonly code = 'NoRunningRunError';

  constructor(verb: string, sessionId: string) {
    super(
      `session.${verb}() requires a running run in session "${sessionId}". ` +
        `The last run is terminal (or there are no runs). Use session.run() to start one.`,
    );
    this.name = 'NoRunningRunError';
  }
}

/**
 * Thrown when `fork({ throughRun: n })` is called with a `throughRun` value
 * that points before the last completed run, making true history truncation
 * impossible without per-run conversation snapshots. Callers must pass
 * `throughRun` equal to or after the last run index, or omit it entirely to
 * fork through the full history.
 *
 * Full per-run snapshot support (Phase D) will lift this restriction.
 */
export class ForkThroughRunError extends Error {
  readonly code = 'ForkThroughRunError';

  constructor(throughRun: number, lastRunIndex: number) {
    super(
      `session.fork({ throughRun: ${throughRun} }) cannot branch before the last completed run ` +
        `(index ${lastRunIndex}): per-run conversation snapshots are not yet available, so ` +
        `forking at an earlier run would include messages from later runs. ` +
        `Pass throughRun >= ${lastRunIndex} or omit it to fork through the full history.`,
    );
    this.name = 'ForkThroughRunError';
  }
}

/**
 * Derive the durable run id from a session id and sequence number.
 *
 * Self-describing: `user-123:2` reveals its session (user-123) + sequence (2)
 * with no side-table lookup. Only constructible from a session + sequence —
 * orphan runs (a durable workflow without a session) are unrepresentable.
 */
export function deriveRunId(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence}`;
}

/**
 * Parse a partial `ConversationHistory` into a `ConversationHistory`. The session
 * stores a full `ConversationHistory`; a brand-new session starts empty.
 */
function historyOrEmpty(history: ConversationHistory | undefined): ConversationHistory {
  return history ?? createConversationHistory();
}

/**
 * Map a `finishReason` to a `RunRef.status`.
 */
function finishReasonToStatus(finishReason: string): RunRef['status'] {
  if (finishReason === 'aborted') return 'aborted';
  if (
    finishReason === 'error' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded'
  ) {
    return 'error';
  }
  return 'completed';
}

/**
 * Parse an ISO-8601 duration string (e.g. `'PT1H'`, `'PT30S'`) into milliseconds.
 * Supports H (hours), M (minutes), S (seconds). Unrecognized strings fall back to 0.
 */
function parseDuration(iso: string): number {
  const match = /^PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(iso);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
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

  /**
   * The currently-in-flight `AgentRun`, if any. Set at `run()` start, cleared
   * when the run settles. Used by `recover()`.
   */
  let currentRun: AgentRun | null = null;
  let currentRunId: string | null = null;

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
        }),
    )) as AgentSession;
  }

  /**
   * Require a durable engine or throw `NoDurableEngineError`.
   */
  function requireEngine(verb: string): AnyRunEngine {
    if (!engine) throw new NoDurableEngineError(verb);
    return engine;
  }

  /**
   * Load the session and return the last `RunRef` iff it is `'running'`,
   * otherwise throw `NoRunningRunError`.
   */
  async function requireRunningRunId(verb: string): Promise<string> {
    const session = await store.load(sessionId);
    const last = session?.runs[session.runs.length - 1];
    if (!last || last.status !== 'running') {
      throw new NoRunningRunError(verb, sessionId);
    }
    return last.runId;
  }

  const handle: SessionHandle = {
    id: sessionId,

    emitter,

    run(input: string): AgentRun {
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

      const resultPromise: Promise<RunResult> = (async () => {
        let reservation:
          | {
              runId: string;
              runningRef: RunRef;
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
              conversationHistory: createConversationHistory(),
              id: sessionId,
            });
          const sequence = session.runs.length;
          const runId = deriveRunId(sessionId, sequence);
          const seededConversation = new Conversation(historyOrEmpty(session.conversationHistory));
          seededConversation.appendUserMessage(input);
          const runningRef: RunRef = {
            runId,
            sequence,
            status: 'running',
            startedAt: new Date().toISOString(),
            agentName,
          };

          reservation = { runId, runningRef, seededConversation };

          return {
            ...session,
            runs: [...session.runs, runningRef],
          };
        });

        if (!reservation) {
          throw new Error(`Failed to reserve a run for session "${sessionId}".`);
        }

        const { runId, runningRef, seededConversation } = reservation;
        currentRunId = runId;

        // Thread the eager AbortController's signal into the run options so
        // abort() works immediately — even before the inner run's own
        // AbortController is created (inside createActiveRun). When the caller
        // aborts via agentRun.abort(), abortController.abort() fires and the
        // combinedSignal inside the run loop drops the provider connection.
        const runOptionsWithSignal = {
          ...runOptions,
          agentName,
          // Stamp the derived runId so tool.* bubble events (ToolStartedBubbleEvent,
          // ToolSettledBubbleEvent, etc.) carry the session run's stable id on the
          // in-memory path. Without this, createActiveRun falls back to runId=''
          // because options.runId is undefined (the durable path gets runId via
          // DurableRunRouting instead, so this is safe to include on both paths).
          runId,
          conversation: seededConversation.current,
          signal: runOptions.signal
            ? AbortSignal.any([runOptions.signal, abortController.signal])
            : abortController.signal,
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
        const subscription = innerRun.toObservable().subscribe({
          next: (e) => outerEmitter.dispatchEvent(e),
          error: () => outerEmitter.complete(),
          complete: () => outerEmitter.complete(),
        });

        let innerResult: RunResult;
        try {
          innerResult = await innerRun.result;
        } catch (err) {
          // The inner run threw (e.g. engine rejected). Transition the
          // persisted ref from 'running' → 'error' so the store is not left
          // with a permanently-running ref that signal()/recover() would act on
          // after the run is already dead.
          subscription.unsubscribe();
          await store.update(sessionId, (freshSession) => {
            if (!freshSession) return undefined;
            const errorRef: RunRef = { ...runningRef, status: 'error' };
            return {
              ...freshSession,
              runs: freshSession.runs.map((r) => (r.runId === runId ? errorRef : r)),
            };
          });
          throw err;
        }

        subscription.unsubscribe();

        // Replace the 'running' ref with the terminal status. Re-load the
        // session in case a concurrent run completed, but replace by runId
        // rather than appending so the runs[] length stays correct.
        await store.update(sessionId, (freshSession) => {
          if (!freshSession) return undefined;
          const terminalRef: RunRef = {
            ...runningRef,
            status: finishReasonToStatus(innerResult.finishReason),
          };
          return {
            ...freshSession,
            conversationHistory: innerResult.conversation.current,
            runs: freshSession.runs.map((r) => (r.runId === runId ? terminalRef : r)),
          };
        });

        return innerResult;
      })();

      // Build the ActiveRun surface backed by the outer emitter so createAgentRun
      // can subscribe to events and abort the run.
      const activeRunWrapper: ActiveRun = {
        result: resultPromise,
        abort(reason?: string): void {
          // Always fire the outer AbortController — this cancels the in-flight
          // generate call (stops billing). Then forward to the inner run so that
          // on the durable path `engine.cancel()` is also triggered, stopping
          // any workflow parked in `ctx.sleep` or `ctx.waitForSignal`.
          abortController.abort(reason);
          activeInnerRun?.abort(reason);
        },
        addEventListener: outerEmitter.addEventListener.bind(
          outerEmitter,
        ) as ActiveRun['addEventListener'],
        removeEventListener: outerEmitter.removeEventListener.bind(
          outerEmitter,
        ) as ActiveRun['removeEventListener'],
        on: outerEmitter.on.bind(outerEmitter) as ActiveRun['on'],
        once: outerEmitter.once.bind(outerEmitter) as ActiveRun['once'],
        subscribe: outerEmitter.subscribe.bind(outerEmitter) as ActiveRun['subscribe'],
        events: outerEmitter.events.bind(outerEmitter) as ActiveRun['events'],
        toObservable: outerEmitter.toObservable.bind(outerEmitter) as ActiveRun['toObservable'],
        complete(): void {
          outerEmitter.complete();
        },
        [Symbol.dispose](): void {
          // Mirror abort(): fire the outer AbortController (stops billing) and
          // forward to the inner run so engine.cancel() is also triggered for
          // workflows parked in ctx.sleep or ctx.waitForSignal.
          abortController.abort();
          activeInnerRun?.abort();
          outerEmitter.complete();
        },
      };

      const agentRun = createAgentRun(activeRunWrapper);
      currentRun = agentRun;

      // Clear currentRun and complete the outer emitter once the run settles.
      void resultPromise
        .catch(() => {
          // Result errors propagate to callers through agentRun.result().
        })
        .finally(() => {
          outerEmitter.complete();
          if (currentRun === agentRun) {
            currentRun = null;
            currentRunId = null;
          }
        });

      return agentRun;
    },

    async recover(): Promise<AgentRun | null> {
      // Fast path: a run is live in this process (same-process disconnect/reconnect).
      if (currentRun !== null) {
        emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null));
        return currentRun;
      }

      // Durable re-attach path (D2): when an engine AND checkpointStore are
      // present, check whether the session's last run is still `'running'` in the
      // durable store. On a crash → restart the bureau re-creates the engine over
      // the SAME store, Weft's `recoverAll()` resumes in-flight workflows on boot,
      // and `engine.resume(runId)` gives a handle to the already-running recovered
      // workflow without starting a new one. Wrap it as an `AgentRun` so the
      // caller can observe the resumed run normally.
      if (engine && checkpointStore) {
        const session = await store.load(sessionId);
        const last = session?.runs[session.runs.length - 1];
        if (last && last.status === 'running') {
          const runId = last.runId;
          try {
            const recoveredHandle = await engine.resume(runId);
            const activeRun = reattachDurableActiveRun(
              { engine, checkpointStore },
              {
                runId,
                handle: recoveredHandle as {
                  readonly id: string;
                  result(): Promise<unknown>;
                },
              },
            );
            const agentRun = createAgentRun(activeRun);
            currentRun = agentRun;
            currentRunId = runId;
            // Persist terminal state when the recovered run settles, mirroring
            // the conflict-aware update path in run(). Without this the persisted RunRef
            // stays 'running' after a recovered run completes, causing
            // subsequent recover()/signal() calls to target a terminal workflow
            // and leaving conversation history un-updated in the session store.
            void (async () => {
              let terminalStatus: RunRef['status'] = 'error';
              let terminalConversation: ConversationHistory | undefined;
              try {
                const settled = await agentRun.result();
                terminalStatus = finishReasonToStatus(settled.finishReason);
                terminalConversation = settled.conversation.current;
              } catch {
                // Recovered run rejected (e.g. engine failure). Leave status 'error';
                // no conversation update — the run never produced a clean result.
              } finally {
                if (currentRun === agentRun) {
                  currentRun = null;
                  currentRunId = null;
                }
                // Reload the session (may have been updated by concurrent activity)
                // and replace the RunRef with its terminal status.
                try {
                  await store.update(sessionId, (freshSession) => {
                    if (!freshSession) return undefined;
                    const terminalRef: RunRef = {
                      ...last,
                      status: terminalStatus,
                    };
                    return {
                      ...freshSession,
                      ...(terminalConversation !== undefined
                        ? { conversationHistory: terminalConversation }
                        : {}),
                      runs: freshSession.runs.map((r) => (r.runId === runId ? terminalRef : r)),
                    };
                  });
                } catch {
                  // Store failure is non-fatal: the in-process state (currentRun=null)
                  // is correct; a stale 'running' ref is tolerable vs. crashing the handle.
                }
              }
            })();
            emitter.dispatchEvent(new SessionRecoverEvent(sessionId, runId));
            return agentRun;
          } catch {
            // engine.resume() throws when the run is already terminal or the
            // engine doesn't have it. Fall through to null — the run is not
            // recoverable on this engine.
          }
        }
      }

      emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null));
      return null;
    },

    async cancel(): Promise<void> {
      // Step 1: Abort the in-process generate signal IMMEDIATELY (stops the
      // provider connection → stops billing). This is the "load-bearing" abort
      // path from architecture.md: we do NOT rely on Weft termination reaching
      // the in-flight call, because Weft only honors cancel at the next `yield*`.
      const run = currentRun;
      const targetRunId = currentRunId;
      if (run) {
        run.abort('cancelled');
      }

      // Step 2: Terminate the Weft workflow in parallel (stops the next step).
      // Fire-and-forget — a failure here is non-fatal (we already aborted the
      // generate signal in step 1). Load the session once and reuse.
      const cancelSession = await store.load(sessionId);
      const targetRun = targetRunId
        ? cancelSession?.runs.find((runRef) => runRef.runId === targetRunId)
        : cancelSession?.runs[cancelSession.runs.length - 1];
      const cancelRunId = targetRun?.runId ?? targetRunId;

      // Emit the cancel event with the targeted run id (null if no runs recorded yet).
      emitter.dispatchEvent(new SessionCancelEvent(sessionId, cancelRunId ?? null));

      if (engine && cancelSession) {
        if (targetRun && targetRun.status === 'running') {
          try {
            await engine.cancel(targetRun.runId);
            // Persist the aborted status only after the durable cancel succeeds.
            // If engine.cancel() throws (e.g. storage fault or stale engine), the
            // Weft workflow may still be running, so marking the session 'aborted'
            // would be incorrect — leave the store in its current state and let
            // the non-fatal catch below swallow the error.
            await store.update(sessionId, (latestSession) => {
              if (!latestSession) return undefined;
              const runs = [...latestSession.runs];
              const runIndex = runs.findIndex((runRef) => runRef.runId === targetRun.runId);
              if (runIndex < 0 || !runs[runIndex]) return latestSession;
              runs[runIndex] = { ...runs[runIndex], status: 'aborted' };
              return {
                ...latestSession,
                runs,
              };
            });
          } catch {
            // Non-fatal: the generate abort already stopped the work.
          }
        }
      }

      currentRun = null;
      currentRunId = null;
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
      const forkedHistory: ConversationHistory = historyOrEmpty(session.conversationHistory);

      // Create the forked session with a new id and empty runs[].
      const newSessionId = crypto.randomUUID();
      const forkedSession = createAgentSession({
        agentName: session.agentName,
        conversationHistory: forkedHistory,
        id: newSessionId,
        runs: [],
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

    async sleep(duration: number | string): Promise<void> {
      // In-memory path: a simple setTimeout (durable path via ctx.sleep is
      // a Phase D concern when a Weft engine is wired through the session).
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

      emitter.dispatchEvent(new SessionSleepEvent(sessionId, ms));
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },

    async signal(name: string, payload?: unknown): Promise<void> {
      const eng = requireEngine('signal');
      const runId = await requireRunningRunId('signal');
      emitter.dispatchEvent(new SessionSignalEvent(sessionId, runId, name, payload));
      await eng.signal(runId, name, payload);
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
      // durable fidelity from the checkpoint otherwise). We use the last run's id
      // regardless of status.
      const session = await store.load(sessionId);
      const last = session?.runs[session.runs.length - 1];
      if (!last) {
        throw new NoRunningRunError('query', sessionId);
      }
      emitter.dispatchEvent(new SessionQueryEvent(sessionId, name, input));
      return eng.query(last.runId, name, input) as Promise<TResult>;
    },

    async monitor(options: MonitorOptions): Promise<boolean> {
      const { every, input, until, maxDuration } = options;
      const everyMs = typeof every === 'number' ? every : parseDuration(every);

      // Reject string durations that parsed to 0 ms — this means the string
      // was not a recognised ISO-8601 PT duration (e.g. '5m' instead of 'PT5M').
      // Silently treating 0 ms as valid would cause a tight spin loop that issues
      // LLM calls as fast as the network allows with no inter-tick sleep.
      if (typeof every === 'string' && everyMs === 0) {
        throw new Error(
          `monitor({ every }) received an invalid duration string: "${every}". ` +
            `Use a number (milliseconds) or an ISO-8601 PT duration such as 'PT5M' or 'PT1H30M'.`,
        );
      }

      // Reject non-positive / non-finite NUMERIC intervals — the string guard
      // above only covers strings. A numeric `every` of 0, a negative value, or
      // NaN/Infinity flows through as `everyMs <= 0` (or non-finite); the
      // inter-tick sleep below is `Math.min(everyMs, remainingMs)` gated on
      // `sleepMs > 0`, so it is skipped entirely and the loop spins through
      // back-to-back agent runs and provider calls with no pause until the
      // predicate or maxDuration stops it. Require a positive, finite interval
      // (PRRT_kwDORvupsc6Mddv9).
      if (typeof every === 'number' && !(everyMs > 0 && Number.isFinite(everyMs))) {
        throw new Error(
          `monitor({ every }) received an invalid numeric interval: ${every}. ` +
            `Use a positive, finite number of milliseconds (e.g. 5000) or an ISO-8601 ` +
            `PT duration such as 'PT5M'.`,
        );
      }

      const maxMs =
        maxDuration !== undefined
          ? typeof maxDuration === 'number'
            ? maxDuration
            : parseDuration(maxDuration)
          : undefined;

      // Reject string maxDuration values that parsed to 0 ms — same guard as
      // `every`. parseDuration returns 0 for unrecognised strings (e.g. '24h'
      // instead of 'PT24H'), which would make the deadline check fire before the
      // first tick ever runs, silently skipping the entire monitor loop.
      if (typeof maxDuration === 'string' && maxMs === 0) {
        throw new Error(
          `monitor({ maxDuration }) received an invalid duration string: "${maxDuration}". ` +
            `Use a number (milliseconds) or an ISO-8601 PT duration such as 'PT24H' or 'PT1H30M'.`,
        );
      }

      // Reject non-finite / negative NUMERIC maxDuration — the string guard above
      // only covers strings. A numeric `maxDuration` of NaN or Infinity is
      // accepted as-is and lands in `maxMs`; the deadline check
      // `Date.now() - startedAt >= maxMs` is then ALWAYS false (every comparison
      // with NaN is false; nothing is >= Infinity), so the loop runs with no
      // effective time cap until the predicate passes or a tick throws. Unlike
      // `every`, a numeric `maxDuration` of 0 is VALID — it means "already
      // expired" (return false on the first deadline check) — so the bound is
      // `>= 0 && finite`, not `> 0` (PRRT_kwDORvupsc6MkjBe).
      if (
        typeof maxDuration === 'number' &&
        !(maxMs !== undefined && maxMs >= 0 && Number.isFinite(maxMs))
      ) {
        throw new Error(
          `monitor({ maxDuration }) received an invalid numeric value: ${maxDuration}. ` +
            `Use a non-negative, finite number of milliseconds (e.g. 60000) or an ISO-8601 ` +
            `PT duration such as 'PT24H'.`,
        );
      }

      const startedAt = Date.now();
      let tick = 0;

      while (true) {
        // Deadline guard — check before starting a new tick.
        if (maxMs !== undefined && Date.now() - startedAt >= maxMs) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
          return false;
        }

        // Emit tick-started (met = null — run hasn't completed yet).
        emitter.dispatchEvent(new SessionMonitorTickEvent(sessionId, tick, null));

        // Each tick is a full agent run.
        const run = handle.run(input);
        let result: RunResult;
        try {
          result = await run.result();
        } catch (err) {
          // A run error is treated as a non-met tick — we emit done(false) and
          // propagate. The caller should handle this as an error condition.
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
          throw err;
        }

        // Surface terminal run FAILURES as errors instead of feeding them to the
        // predicate. `run.result()` resolves (it does not throw) for normal
        // operative failures — `error`, `aborted`, `budget-exceeded`,
        // `elicitation-denied` — so the catch above never runs for these. Without
        // this check a predicate that returns false would keep sleeping and
        // re-running after a provider/tool failure instead of surfacing it, the
        // same way the catch block does for thrown errors (PRRT_kwDORvupsc6MddwB).
        if (FAILURE_FINISH_REASONS.has(result.finishReason)) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
          // Prefer the run's own error; otherwise synthesize one naming the
          // finish reason ('aborted'/'budget-exceeded'/'elicitation-denied'
          // typically carry no `error`).
          throw result.error instanceof Error
            ? result.error
            : new Error(
                `monitor tick ended with finishReason '${result.finishReason}' before the ` +
                  `predicate could be evaluated.`,
              );
        }

        // Evaluate the predicate.
        const met = until(result);
        tick += 1;

        // Emit tick-completed with the predicate result.
        emitter.dispatchEvent(new SessionMonitorTickEvent(sessionId, tick - 1, met));

        if (met) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, true, tick));
          return true;
        }

        // Sleep between ticks — respects the maxDuration deadline (don't sleep
        // past the deadline; wake up early if needed).
        const elapsed = Date.now() - startedAt;
        if (maxMs !== undefined && elapsed >= maxMs) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
          return false;
        }
        const remainingMs = maxMs !== undefined ? maxMs - elapsed : Infinity;
        const sleepMs = Math.min(everyMs, remainingMs);
        if (sleepMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
        }
      }
    },

    async getSession(): Promise<AgentSession> {
      return loadOrCreate();
    },
  };

  return handle;
}
