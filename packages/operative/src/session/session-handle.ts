import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';

import type { AgentRun } from '../agent-run';
import { createAgentRun } from '../agent-run';
import type { AgentSession, RunRef } from '../agent-session';
import { createAgentSession } from '../agent-session';
import { createActiveRun } from '../create-run';
import type { AnyRunEngine } from '../durable/create-run-engine';
import type { OperativeEventMap } from '../events';
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
import type { RunOptions, RunResult } from '../types';
import type { SessionStore } from './types';

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
   * Returns the same `AgentRun` handle that is observing the already-running
   * workflow. Returns `null` when there is no in-flight run to reattach to
   * (disconnect = keep going; this is NOT "resume from the last message").
   *
   * Over HTTP: a client reconnecting after a network drop calls `recover()` to
   * re-subscribe to the in-flight run's event stream.
   */
  recover(): AgentRun | null;

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
   */
  engine?: AnyRunEngine;
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
  const { store, engine, agentName, runOptions } = context;
  const emitter = context.emitter ?? new TypedEventTarget<OperativeEventMap>();

  /**
   * The currently-in-flight `AgentRun`, if any. Set at `run()` start, cleared
   * when the run settles. Used by `recover()`.
   */
  let currentRun: AgentRun | null = null;

  /**
   * Load the session from the store, creating it if absent.
   */
  async function loadOrCreate(): Promise<AgentSession> {
    const existing = await store.load(sessionId);
    if (existing) return existing;

    const fresh = createAgentSession({
      agentName,
      conversationHistory: createConversationHistory(),
      id: sessionId,
    });
    await store.save(fresh);
    return fresh;
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
      // Seed the conversation with the stored history (we build it lazily via
      // the result promise so `run()` returns synchronously).
      const eagerConversation = new Conversation(createConversationHistory());
      eagerConversation.appendUserMessage(input);

      const activeRun = createActiveRun({ ...runOptions, conversation: eagerConversation.current });
      const agentRun = createAgentRun(activeRun);
      currentRun = agentRun;

      // After the run settles: update the conversation history and append the
      // RunRef to the session's `runs[]`. This is best-effort; callers should
      // not depend on session persistence completing before iterating the run.
      void agentRun
        .result()
        .then(async (result) => {
          const session = await loadOrCreate();
          // Build the conversation from the completed run's history, merged with
          // the stored history (stored → user input → assistant response).
          const sequence = session.runs.length;
          const ref: RunRef = {
            runId: deriveRunId(sessionId, sequence),
            sequence,
            status: finishReasonToStatus(result.finishReason),
            startedAt: new Date().toISOString(),
          };
          const updated: AgentSession = {
            ...session,
            conversationHistory: result.conversation.current,
            runs: [...session.runs, ref],
            updatedAt: new Date().toISOString(),
          };
          await store.save(updated);
        })
        .catch(() => {
          // If result rejects, the session update is skipped. The run's error
          // propagates to the caller through `agentRun.result()`.
        })
        .finally(() => {
          if (currentRun === agentRun) currentRun = null;
        });

      return agentRun;
    },

    recover(): AgentRun | null {
      // Emit immediately with runId=null: recover() is synchronous and we don't
      // have the derived run id available without an async store lookup. Null is
      // the documented "pre-recovery" value per the event class contract.
      emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null));
      return currentRun;
    },

    async cancel(): Promise<void> {
      // Step 1: Abort the in-process generate signal IMMEDIATELY (stops the
      // provider connection → stops billing). This is the "load-bearing" abort
      // path from architecture.md: we do NOT rely on Weft termination reaching
      // the in-flight call, because Weft only honors cancel at the next `yield*`.
      const run = currentRun;
      if (run) {
        run.abort('cancelled');
      }

      // Step 2: Terminate the Weft workflow in parallel (stops the next step).
      // Fire-and-forget — a failure here is non-fatal (we already aborted the
      // generate signal in step 1). Load the session once and reuse.
      const cancelSession = await store.load(sessionId);
      const lastRunId = cancelSession?.runs[cancelSession.runs.length - 1]?.runId ?? null;

      // Emit the cancel event with the last known run id (null if no runs recorded yet).
      emitter.dispatchEvent(new SessionCancelEvent(sessionId, lastRunId));

      if (engine && cancelSession) {
        const last = cancelSession.runs[cancelSession.runs.length - 1];
        if (last && last.status === 'running') {
          try {
            await engine.cancel(last.runId);
          } catch {
            // Non-fatal: the generate abort already stopped the work.
          }
          // Persist the aborted status.
          const runs = [...cancelSession.runs];
          const lastIndex = runs.length - 1;
          if (lastIndex >= 0 && runs[lastIndex]) {
            runs[lastIndex] = { ...runs[lastIndex], status: 'aborted' };
          }
          await store.save({
            ...cancelSession,
            runs,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      currentRun = null;
    },

    async fork(options?: { throughRun?: number }): Promise<SessionHandle> {
      const session = await loadOrCreate();

      // Default: fork through the last run.
      const throughSequence = options?.throughRun ?? session.runs.length - 1;

      // Copy the conversation history. For Phase B, we use the session's stored
      // history as the authoritative snapshot (it reflects all completed runs).
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

      // Suppress unused — `throughSequence` is the canonical parameter; a future
      // Phase D impl will snapshot conversation at exactly that sequence boundary.
      void throughSequence;

      // Emit after the forked session is persisted so the id is stable.
      emitter.dispatchEvent(new SessionForkEvent(sessionId, newSessionId, options?.throughRun));

      return createSessionHandle(newSessionId, context);
    },

    async sleep(duration: number | string): Promise<void> {
      // In-memory path: a simple setTimeout (durable path via ctx.sleep is
      // a Phase D concern when a Weft engine is wired through the session).
      const ms = typeof duration === 'number' ? duration : parseDuration(duration);
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
      const maxMs =
        maxDuration !== undefined
          ? typeof maxDuration === 'number'
            ? maxDuration
            : parseDuration(maxDuration)
          : undefined;

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
