import type { RuntimeServices, TypedEventTarget } from 'lifecycle';

import type { AgentRun } from '../agent-run';
import type { AgentSession } from '../agent-session';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import type { OperativeEventMap } from '../events';
import type { LivenessSnapshot, Subscription } from '../liveness';
import type { CleanupAcknowledgement, ClosedOptions, RunOptions, RunResult } from '../types';
import type { SessionStore } from './types';

/**
 * Plain `Omit<T, K>` maps over `K`, not over `T` — for a union `T` it
 * collapses every member into one merged, looser shape. That would flatten
 * away `RunOptions`'s AB-236 `runId`/`steering` discriminated pair (see the
 * identical note on `scheduler/types.ts`'s `SchedulerRunOptions`). This
 * distributes `Omit` over each union member first, via the naked type
 * parameter `T extends unknown ? ... : never` distributes on.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Options passed to `createSessionHandle` that define the agent's run behavior.
 * These are the portions of `RunOptions` that are constant across every `run()`
 * call within the session (the LLM backend, toolbox, hooks, limits, etc.).
 *
 * Omits `runId` as well as `conversation`: a session's `runId` is always
 * DERIVED (`deriveRunId(sessionId, sequence)`, below) and stamped onto
 * `runOptionsWithSignal` inside `run()`, overwriting whatever this bag
 * carries — a caller can never meaningfully supply one. Without this
 * omission, `RunOptions`'s AB-236 `runId`/`steering` pairing would force a
 * caller configuring a steering-enabled session to invent a throwaway
 * `runId` that gets silently discarded and cannot represent the session's
 * actual (and multiple, sequence-numbered) run identities. `steering`
 * itself is unaffected — a session-scoped `SteeringGate` config is exactly
 * what this option bag is for.
 */
export type SessionRunOptions = DistributiveOmit<RunOptions, 'conversation' | 'runId'>;

/**
 * Options for `session.monitor()` — a process-local conditional watch loop that runs
 * the agent on a repeating cadence until a predicate is satisfied or a deadline
 * is reached.
 *
 * Each tick starts a new `AgentRun` with `input` as the prompt. Individual runs
 * may be durable, but the monitor controller and its timers are never persisted.
 * Process exit loses the loop even when the session has a durable engine. The
 * `until` predicate receives the completed `RunResult` and returns `true` when
 * the condition is met (ending the loop). If `until` returns `false`, the loop
 * sleeps for `every` milliseconds and starts the next tick.
 *
 * The predicate is evaluated in-process after each run. Aborting `signal`
 * aborts the active tick or clears the inter-tick timer.
 */
export interface MonitorOptions {
  /** Abort this process-local monitor loop and clear its current timer. */
  signal?: AbortSignal;

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
   * Must be a pure function of the run result. Captured process state is lost
   * with the monitor loop when the host process exits.
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
 * `SessionHandle`'s own `LivenessSnapshot`, narrowed to `kind: 'session'`
 * (AB-88/AB-214/AB-215 — obs-02).
 */
export type SessionLivenessSnapshot = LivenessSnapshot & { kind: 'session' };

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
   * keep going; this is NOT "resume from the last message"). This is also the
   * return value when a durable re-attach was ATTEMPTED and every candidate
   * `running` ref rejected — `recover()` never throws for this. To tell the
   * two apart, read `emitter`: the dispatched `session.recover`
   * `SessionRecoverEvent` carries an empty `failures` array for "nothing to
   * resume" and a non-empty one (each entry with the rejected `runId` and its
   * `error`) for "resume was attempted and failed".
   *
   * Over HTTP: a client reconnecting after a network drop calls `recover()` to
   * re-subscribe to the in-flight run's event stream.
   */
  recover(): Promise<AgentRun | null>;

  /**
   * Deliberate stop — abort the `generate` `AbortController` IMMEDIATELY (stops the
   * provider call and stops billing), AND terminate the Weft workflow in parallel
   * (stops the next step from starting). Does NOT rely on Weft termination reaching
   * the in-flight call. The attached run owns its terminal persistence;
   * await that run's result() to observe the committed outcome and transcript.
   * Without an attached run, reconcile the actual durable terminal state and
   * checkpoint history when configured, retaining existing history otherwise.
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
   * Process-local delay for host coordination. This always uses a local timer;
   * process exit loses the delay even when this session has a durable engine.
   * Use a run-level Weft wakeup or signal, or a Bureau recurring schedule, when
   * the operation must survive restart.
   *
   * @param duration - Milliseconds (number) or an ISO-8601 duration string
   *   (e.g. `'PT30S'`, `'PT1H'`).
   */
  sleep(duration: number | string, options?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Fire-and-forget signal into the in-flight run's workflow. The agent loop's
   * `ctx.waitForSignal` consumes it. Releases a `requestHumanInput` park and
   * (AB-44 — resume agent reasoning with a delivered signal payload) CONTINUES
   * the same run: the delivered payload is rendered into the conversation as a
   * deterministic `[signal:{name}] {payload}` user-role message and one more
   * agent generation step runs before the run's final result is produced.
   * Requires a durable engine and a currently-running run.
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
   * Run the agent in this host process on a repeating cadence until a predicate
   * is satisfied or a deadline is reached. The controller and inter-tick timers
   * are process-local even when individual runs use a durable engine.
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
   * Current `LivenessSnapshot` for this session (AB-88/AB-214/AB-215,
   * obs-02). Synchronous, never starts work, never blocks, never mutates.
   * Session liveness is process-local ({@link LivenessSnapshot.durability}
   * is always `'process-local'`, per AB-39): a `session.monitor()` loop
   * drives the watchdog while it runs, and delivering a signal that
   * releases a `'signal'`/`'review'` declared wait (AB-88's unbounded-wait
   * exception) clears it without the elapsed wait time counting as missed
   * pulses.
   */
  snapshot(): SessionLivenessSnapshot;

  /**
   * Independent, non-consuming liveness observer (AC10). Delivers the
   * current snapshot synchronously before returning, then a new snapshot on
   * every revision change. Unlike an `AgentRun`, a `SessionHandle` never
   * reaches a terminal liveness status — it can always accept another
   * `run()` — so this subscription stays open until `unsubscribe()` or
   * `options.signal` aborts it.
   */
  subscribeSnapshot(
    observer: (snapshot: SessionLivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;

  /**
   * The event emitter for session-scoped events (session.recover,
   * session.cancel, session.fork, session.sleep, session.signal,
   * session.update, session.query). Subscribe here to observe session
   * verb transitions without waiting for an active run.
   */
  readonly emitter: TypedEventTarget<OperativeEventMap>;

  /**
   * Handle-scoped cleanup acknowledgement (AB-37/AB-204/AB-210). Resolves
   * `{ status: 'not-required' }` immediately when no run is currently live
   * on this handle. Otherwise delegates to the live `currentRun`'s own
   * `AgentRun.closed()` (AB-204, itself delegating to `ActiveRun.closed()`)
   * and returns the IDENTICAL `CleanupAcknowledgement` object.
   *
   * This is deliberately NOT the full-run-history acknowledgement across
   * every run this session has ever owned: `packages/operative` has no
   * dependency on `packages/bureau`, so this method cannot see
   * `getRunSessionIdentifier` or the Bureau `store`. That session-level
   * acknowledgement is Bureau's responsibility, folded into its
   * `deleteSession` fix.
   */
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
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
  engine?: RegistryAgnosticEngine;
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
  runOptions?: SessionRunOptions;
  /**
   * Optional event emitter for session-scoped events (session.recover,
   * session.cancel, session.fork, session.sleep, session.signal,
   * session.update, session.query). When provided, each verb method
   * dispatches the corresponding typed event. Created internally if omitted.
   */
  emitter?: TypedEventTarget<OperativeEventMap>;
  /**
   * Process-local timer injection used by deterministic tests. Still wins
   * over `runtime.timers` when supplied explicitly — this generalizes the
   * seam onto `RuntimeServices.timers` rather than replacing it (AB-253).
   */
  setTimeoutFunction?: (callback: () => void, milliseconds: number) => unknown;
  /** Matching cleanup function for `setTimeoutFunction`. */
  clearTimeoutFunction?: (timer: unknown) => void;
  /**
   * The AB-92/AB-252/AB-253 injectable runtime-service seam: wall time,
   * monotonic time, timers, identifiers, randomness, and deferred-work
   * tracking. Resolved exactly once at construction — omitted, this handle
   * reads the real globals via `createDefaultRuntimeServices()`; a test
   * composes its own deterministic instance with
   * `createManualRuntimeServices()` from `@lostgradient/operative/test` so
   * `sleep()`/`monitor()`'s inter-tick delay and every id/timestamp this
   * handle mints are fully time-controlled.
   */
  runtime?: RuntimeServices;
}

/** Raised synchronously when a session run has no configured execution options. */
export class MissingRunOptionsError extends Error {
  constructor() {
    super('Session run options are required to start a run.');
    this.name = 'MissingRunOptionsError';
  }
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
