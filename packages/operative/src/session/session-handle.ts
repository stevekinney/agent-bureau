import type { WorkflowState } from '@lostgradient/weft';
import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import type { RuntimeServices } from 'lifecycle';
import {
  CompletableEventTarget,
  createDefaultRuntimeServices,
  ForwardedEvent,
  TypedEventTarget,
} from 'lifecycle';

import type { AgentRun } from '../agent-run';
import { createAgentRun } from '../agent-run';
import type { AgentSession, RunRef } from '../agent-session';
import { createAgentSession } from '../agent-session';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import type { ActiveRun } from '../create-run';
import { createActiveRun } from '../create-run';
import { reattachDurableActiveRun } from '../durable/active-run-adapter';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import {
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from '../durable/run-workflow';
import type {
  CombinedOperativeEventMap,
  OperativeEventMap,
  SessionRecoverFailure,
} from '../events';
import {
  HumanWaitParkedEvent,
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
import type {
  AgentRunLivenessSnapshot,
  DeclaredWait,
  LivenessAssessment,
  LivenessLifecycleStatus,
  LivenessProgressState,
  LivenessReachability,
  LivenessSnapshot,
  StallWatchdog,
  StallWatchdogClock,
  Subscription,
} from '../liveness';
import { createStallWatchdog, LIVENESS_POLICY_VERSION, sessionMonitorPolicy } from '../liveness';
import type {
  CleanupAcknowledgement,
  ClosedOptions,
  FinishReason,
  RunOptions,
  RunResult,
} from '../types';
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
  'tripwire',
]);

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
  runOptions: SessionRunOptions;
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

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = candidate.messages[id];
    const baseMessage = base.messages[id];
    const message =
      candidateMessage &&
      (!baseMessage || !messagesAreEqual(candidateMessage, baseMessage) || !current.messages[id])
        ? candidateMessage
        : (current.messages[id] ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

function newestRunningRunRef(session: AgentSession | undefined): RunRef | undefined {
  return [...(session?.runs ?? [])].reverse().find((runRef) => runRef.status === 'running');
}

/**
 * Map a `finishReason` to a `RunRef.status`.
 */
function finishReasonToStatus(finishReason: string): RunRef['status'] {
  if (finishReason === 'aborted') return 'aborted';
  if (
    finishReason === 'error' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded' ||
    finishReason === 'tripwire'
  ) {
    return 'error';
  }
  return 'completed';
}

/**
 * Map a genuine Weft-level terminal `WorkflowStatus` — one reached WITHOUT the
 * `agentRun` workflow ever returning an {@link AgentRunWorkflowResult} (a real
 * engine failure, an operator/adapter cancellation, or a circuit-breaker /
 * deadline timeout) — to the matching `RunRef` status. `run-workflow.ts`
 * always RETURNS normally, even for an operative-level failure (it encodes
 * that in `finishReason`, see `finishReasonToStatus`), so this only fires for
 * a failure the workflow itself could not have produced.
 */
function engineStatusToRunRefStatus(
  status: 'failed' | 'cancelled' | 'timed-out',
): RunRef['status'] {
  return status === 'cancelled' ? 'aborted' : 'error';
}

/**
 * Load a terminal run's conversation history straight from its checkpoint,
 * without resuming it. Returns `undefined` when no transcript was ever
 * checkpointed (e.g. the run failed before its first step) or the checkpoint
 * read fails — mirroring the "tolerate a missing conversation" behavior of
 * the settle path in `recover()`'s success branch.
 */
async function loadTerminalConversationHistory(
  checkpointStore: CheckpointStore,
  runId: string,
): Promise<ConversationHistory | undefined> {
  try {
    const checkpoint = await checkpointStore.loadCheckpoint(runId);
    if (checkpoint.conversation === null) return undefined;
    return Conversation.from(checkpoint.conversation).current;
  } catch {
    return undefined;
  }
}

/**
 * Read a terminal run's outcome (status + conversation) directly from the
 * engine/checkpoint store, WITHOUT resuming it (AB-28). Used when
 * `engine.resume(runId)` rejects: that rejection means either the workflow is
 * already terminal, or the engine has no record of it at all — `engine.get()`
 * distinguishes the two (it never throws for a terminal run, and returns
 * `null` for an unknown one), so only a genuinely terminal run is reconciled.
 *
 * Returns `null` when the engine has no record of this workflow (an unknown
 * runId must NOT be marked terminal) or when `engine.get()` reports it as
 * still non-terminal (`resume()` should have succeeded in that case — leave
 * the RunRef alone rather than guessing at a status).
 */
async function readTerminalRunOutcome(
  engine: RegistryAgnosticEngine,
  checkpointStore: CheckpointStore,
  runId: string,
): Promise<{ status: RunRef['status']; conversation?: ConversationHistory } | null> {
  let state: WorkflowState | null;
  try {
    state = await engine.get(runId);
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.status === 'pending' || state.status === 'running' || state.status === 'suspended') {
    return null;
  }

  const conversation = await loadTerminalConversationHistory(checkpointStore, runId);

  if (state.status !== 'completed') {
    return { status: engineStatusToRunRefStatus(state.status), conversation };
  }

  // The workflow's own declared return type — the same trusted-internal-
  // contract cast `active-run-adapter.ts` makes after `handle.result()`.
  const summary = normalizeAgentRunWorkflowResult(state.result);
  return { status: finishReasonToStatus(summary.finishReason), conversation };
}

/**
 * Reconcile a stranded 'running' `RunRef` whose durable workflow already
 * reached a terminal state before `recover()` could resume it (AB-28) —
 * closing the gap the terminal-status write below (`recover()`'s success
 * branch) does not cover, and the gap left by a store failure in that same
 * write. Mirrors that write's conflict-aware `store.update` + conversation-
 * history reconciliation exactly, so a stranded session converges the same
 * way a live recovered run does.
 *
 * Idempotent: re-checks the ref's status inside the updater, so a session
 * already reconciled by a prior `recover()` call (or a concurrent one) is
 * left untouched rather than reprocessed.
 */
async function reconcileTerminalRunRef(
  store: SessionStore,
  engine: RegistryAgnosticEngine,
  checkpointStore: CheckpointStore,
  sessionId: string,
  runningRef: RunRef,
): Promise<void> {
  const outcome = await readTerminalRunOutcome(engine, checkpointStore, runningRef.runId);
  if (!outcome) return;

  try {
    await store.update(sessionId, (freshSession) => {
      if (!freshSession) return undefined;
      const current = freshSession.runs.find((r) => r.runId === runningRef.runId);
      if (!current || current.status !== 'running') return undefined;
      const terminalRef: RunRef = { ...current, status: outcome.status };
      return {
        ...freshSession,
        ...(outcome.conversation !== undefined
          ? {
              conversationHistory: appendConversationMessages(
                freshSession.conversationHistory,
                outcome.conversation,
                outcome.conversation,
              ),
            }
          : {}),
        runs: freshSession.runs.map((r) => (r.runId === runningRef.runId ? terminalRef : r)),
      };
    });
  } catch {
    // Store failure is non-fatal: the caller already returns null for this
    // terminal run either way; a stale 'running' ref is tolerable vs.
    // crashing the handle (mirrors the settle path in recover()'s success
    // branch).
  }
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
  let currentRun: AgentRun | null = null;
  let currentRunId: string | null = null;

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
  const livenessClock: StallWatchdogClock = {
    now: () => runtime.monotonic.now(),
    setTimeout: setTimeoutFunction,
    clearTimeout: clearTimeoutFunction,
  };

  const livenessStartedAt = runtime.clock.nowISO();
  let livenessRevision = 0;
  let livenessStatus: LivenessLifecycleStatus = 'created';
  let livenessLastTransitionAt = livenessStartedAt;
  let declaredWait: DeclaredWait | undefined;

  /**
   * The `session.monitor` watchdog (obs-01's `sessionMonitorPolicy` row).
   * Created when `monitor()` starts — its cadence is the caller's `every`,
   * only known then — and disposed in `monitor()`'s `finally`: a session not
   * currently being polled accrues no missed pulses. Also temporarily
   * disposed (without clearing `sessionWatchdogCadenceMs`) while a
   * `HumanWaitParkedEvent` is outstanding, per AB-88's unbounded-wait
   * exception for `'signal'`/`'review'` declared waits: elapsed time during
   * an unbounded human wait must not accrue toward stalled/unreachable, and
   * disposing (rather than merely ignoring ticks) discards that elapsed time
   * outright instead of letting it appear as a burst of missed pulses the
   * moment the watchdog is asked to assess again.
   */
  let sessionWatchdog: StallWatchdog | undefined;
  let sessionWatchdogCadenceMs: number | undefined;

  /** The run + signal name a `HumanWaitParkedEvent` is currently parked on, if any. */
  let parkedRunId: string | undefined;
  let parkedSignalName: string | undefined;

  interface LivenessSubscriberRecord {
    readonly observer: (snapshot: SessionLivenessSnapshot) => void;
    closed: boolean;
    readonly detach: () => void;
  }

  const livenessSubscribers = new Set<LivenessSubscriberRecord>();
  let cachedLivenessSnapshot: SessionLivenessSnapshot | undefined;
  let cachedLivenessRevision = -1;

  function deriveSessionAssessment(
    reachability: LivenessReachability,
    progress: LivenessProgressState,
  ): LivenessAssessment {
    if (declaredWait || livenessStatus === 'waiting') return 'legitimately-waiting';
    if (reachability === 'unreachable') return 'unreachable';
    if (progress === 'stalled') return 'alive-but-stalled';
    return 'healthy';
  }

  function computeLivenessSnapshot(): SessionLivenessSnapshot {
    const watchdogAssessment = sessionWatchdog?.assess();
    // A fresh, frozen copy — `watchdog.assess()` already returns a spread
    // copy, not its own internal array, but freezing here (not just the
    // outer snapshot) keeps a caller's mutation from corrupting a CACHED
    // snapshot object read again at the same revision (the "Cached
    // snapshot" capability's identity-stability contract).
    const evidence = Object.freeze(
      watchdogAssessment?.evidence ? [...watchdogAssessment.evidence] : [],
    );
    // AC3: `session.monitor.tick`'s `'host-reachability'` pulse is this
    // session's only evidence source, so it — and only it — governs
    // `lastHeartbeatAt`/`lastActivityAt`/`lastProgressAt` here. Unlike
    // `active-run-liveness.ts`'s agent-run-level aggregation (where a host
    // pulse proves scheduling, not the watched work's own progress), a
    // session has no finer-grained evidence to prefer.
    const lastPulseAt = evidence.length > 0 ? evidence[evidence.length - 1]?.at : undefined;
    const reachability: LivenessReachability = watchdogAssessment?.reachability ?? 'unknown';
    const progress: LivenessProgressState = watchdogAssessment?.progress ?? 'unknown';

    return Object.freeze({
      id: sessionId,
      kind: 'session',
      startedAt: livenessStartedAt,
      revision: livenessRevision,
      status: livenessStatus,
      lastTransitionAt: livenessLastTransitionAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: true,
      attempt: 0,
      reachability,
      progress,
      assessment: deriveSessionAssessment(reachability, progress),
      observedAt: livenessClock.now(),
      ...(lastPulseAt !== undefined
        ? { lastHeartbeatAt: lastPulseAt, lastActivityAt: lastPulseAt, lastProgressAt: lastPulseAt }
        : {}),
      missedPulseCount: watchdogAssessment?.missedPulseCount ?? 0,
      ...(declaredWait !== undefined ? { declaredWait } : {}),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence,
    });
  }

  // "Cached snapshot" capability: repeated reads before a represented change
  // return the identical object by reference — a real state change always
  // advances `livenessRevision` first (via `advanceLiveness()`), so caching
  // keyed on it is exact.
  function readLivenessSnapshot(): SessionLivenessSnapshot {
    if (cachedLivenessSnapshot && cachedLivenessRevision === livenessRevision) {
      return cachedLivenessSnapshot;
    }
    cachedLivenessSnapshot = computeLivenessSnapshot();
    cachedLivenessRevision = livenessRevision;
    return cachedLivenessSnapshot;
  }

  function notifyLiveness(): void {
    const snapshot = readLivenessSnapshot();
    for (const record of [...livenessSubscribers]) {
      if (record.closed) continue;
      try {
        record.observer(snapshot);
      } catch {
        // A throwing subscriber must not escape into the caller driving this
        // revision — mirrors `active-run-liveness.ts`'s identical isolation.
      }
    }
  }

  function advanceLiveness(): void {
    livenessRevision += 1;
    notifyLiveness();
  }

  /**
   * Sets this session's own lifecycle status and declared wait as ONE
   * revision. Always advances (even when `next` equals the current status)
   * so a wait payload change while already `'waiting'` (not expected today,
   * but not excluded) still reaches subscribers. Omitting `wait` clears any
   * previously declared wait.
   */
  function setLivenessState(next: LivenessLifecycleStatus, wait?: DeclaredWait): void {
    if (livenessStatus !== next) {
      livenessStatus = next;
      livenessLastTransitionAt = runtime.clock.nowISO();
    }
    // Frozen so a caller mutating a returned snapshot's `declaredWait`
    // cannot corrupt this handle's own internal liveness state (the
    // snapshot's `Object.freeze` is shallow and does not reach here on its
    // own) — every snapshot embeds this SAME reference until the wait ends.
    declaredWait = wait ? Object.freeze({ ...wait }) : undefined;
    advanceLiveness();
  }

  /**
   * Disposes the active `session.monitor` watchdog without clearing
   * `sessionWatchdogCadenceMs`, so `resumeSessionWatchdogAfterWait` can
   * rebuild it once the outstanding wait clears. A no-op when no watchdog is
   * active (a `HumanWaitParkedEvent` outside `monitor()`).
   */
  function pauseSessionWatchdogForWait(): void {
    if (!sessionWatchdog) return;
    sessionWatchdog.dispose();
    sessionWatchdog = undefined;
  }

  /**
   * Rebuilds the `session.monitor` watchdog with a FRESH instance (discarding
   * whatever elapsed time and evidence accrued while paused) once an
   * outstanding wait clears. A no-op when no `monitor()` loop is active
   * (`sessionWatchdogCadenceMs` was never set, or its own `finally` already
   * cleared it).
   */
  function resumeSessionWatchdogAfterWait(): void {
    if (sessionWatchdogCadenceMs === undefined || sessionWatchdog !== undefined) return;
    sessionWatchdog = createStallWatchdog(
      sessionMonitorPolicy(sessionWatchdogCadenceMs),
      livenessClock,
      { onAssessmentChange: advanceLiveness },
    );
    sessionWatchdog.recordPulse('host-reachability', 0);
  }

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
    if (currentRun !== null && currentRunId === null) {
      throw new NoRunningRunError(verb, sessionId);
    }
    const target = currentRunId
      ? session?.runs.find((runRef) => runRef.runId === currentRunId)
      : newestRunningRunRef(session);
    if (!target || target.status !== 'running') {
      throw new NoRunningRunError(verb, sessionId);
    }
    return target.runId;
  }

  const handle: SessionHandle = {
    id: sessionId,

    emitter,

    closed(options?: ClosedOptions): Promise<CleanupAcknowledgement> {
      // Scoped to what this handle itself tracks (AB-210): `not-required`
      // when nothing is live, otherwise delegate to the live run's own
      // `closed()` — its identical returned object satisfies the "delegate
      // and return the same object" acceptance criterion for free.
      if (currentRun === null) {
        return Promise.resolve({ status: 'not-required' });
      }
      return currentRun.closed(options);
    },

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

      // This call's own run id, once the reservation resolves — used to
      // correlate a `HumanWaitParkedEvent` and to clean up park bookkeeping
      // when this run settles (liveness, AB-215).
      let thisRunId: string | undefined;

      // Eagerly reflect this run as the session's own current activity.
      // Clears any leftover declared wait from a prior run.
      setLivenessState('running');

      const resultPromise: Promise<RunResult> = (async () => {
        let reservation:
          | {
              runId: string;
              runningRef: RunRef;
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
              conversationHistory: createConversationHistory(),
              id: sessionId,
              runtime,
            });
          const sequence = session.runs.length;
          const runId = deriveRunId(sessionId, sequence);
          const baseConversationHistory = session.conversationHistory;
          const seededConversation = new Conversation(historyOrEmpty(session.conversationHistory));
          seededConversation.appendUserMessage(input);
          const runningRef: RunRef = {
            runId,
            sequence,
            status: 'running',
            startedAt: runtime.clock.nowISO(),
            agentName,
          };

          reservation = { runId, runningRef, baseConversationHistory, seededConversation };

          return {
            ...session,
            runs: [...session.runs, runningRef],
          };
        });

        if (!reservation) {
          throw new Error(`Failed to reserve a run for session "${sessionId}".`);
        }

        const { runId, runningRef, baseConversationHistory, seededConversation } = reservation;
        currentRunId = runId;
        thisRunId = runId;

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
          // AB-253: an explicit `runOptions.runtime` still wins; otherwise every
          // run() this session dispatches shares the SAME composed runtime the
          // handle itself was constructed with, so a session driven by a manual
          // runtime stays deterministic end-to-end rather than each run minting
          // its own default (real-globals) instance.
          runtime: runOptions.runtime ?? runtime,
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
        const completeOuterEmitter = outerEmitter.complete.bind(outerEmitter);
        const subscription = innerRun.toObservable().subscribe({
          next: (e) => {
            outerEmitter.dispatchEvent(e);
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
              parkedRunId = runId;
              parkedSignalName = humanWait.signalName;
              pauseSessionWatchdogForWait();
              setLivenessState('waiting', {
                reason: humanWait.prompt !== undefined ? 'review' : 'signal',
                startedAt: livenessClock.now(),
                dependency: humanWait.signalName,
                wakeCondition: `session.signal('${humanWait.signalName}')`,
              });
            }
          },
          error: completeOuterEmitter,
          complete: completeOuterEmitter,
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
            conversationHistory: appendConversationMessages(
              freshSession.conversationHistory,
              innerResult.conversation.current,
              baseConversationHistory,
            ),
            runs: freshSession.runs.map((r) => (r.runId === runId ? terminalRef : r)),
          };
        });

        return innerResult;
      })();

      // closed()'s not-required fast path (AB-204) — see the identical flag
      // in create-run.ts / active-run-adapter.ts.
      let cancelRequested = false;

      // Build the ActiveRun surface backed by the outer emitter so createAgentRun
      // can subscribe to events and abort the run.
      const activeRunWrapper: ActiveRun = {
        result: resultPromise,
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
            (runOptions.signal?.aborted ?? false) ||
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
            id: currentRunId ?? sessionId,
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
          // Liveness (AB-215): this run is done. Clear a still-outstanding
          // park (e.g. cancel()/abort() ended the run while parked) so a
          // paused watchdog is not stranded, then reflect the session as
          // idle again — a monitor tick's own pulse/wait overrides this
          // immediately if this run() call was one of its ticks.
          if (thisRunId !== undefined && parkedRunId === thisRunId) {
            parkedRunId = undefined;
            parkedSignalName = undefined;
            resumeSessionWatchdogAfterWait();
          }
          setLivenessState('created');
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
      // present, check whether any session run is still `'running'` in the
      // durable store. On a crash → restart the bureau re-creates the engine over
      // the SAME store, Weft's `recoverAll()` resumes in-flight workflows on boot,
      // and `engine.resume(runId)` gives a handle to the already-running recovered
      // workflow without starting a new one. Wrap it as an `AgentRun` so the
      // caller can observe the resumed run normally.
      if (engine && checkpointStore) {
        const session = await store.load(sessionId);
        const runningRefs = [...(session?.runs ?? [])]
          .reverse()
          .filter((runRef) => runRef.status === 'running');
        // Every engine.resume() rejection encountered below, keyed by the
        // runId that failed. Reported on the final SessionRecoverEvent so a
        // failed re-attach is distinguishable from the benign "no running
        // refs at all" outcome, which reports the identical runId: null but
        // an empty failures array.
        const failures: SessionRecoverFailure[] = [];
        for (const runningRef of runningRefs) {
          const runId = runningRef.runId;
          try {
            const recoveredHandle = await engine.resume(runId);
            const activeRun = reattachDurableActiveRun(
              { engine, checkpointStore },
              {
                runId,
                handle: recoveredHandle,
                // AB-304: the same registry a fresh run() call threads
                // through `RunOptions.childRegistry` — see the identical
                // reasoning on `reattachDurableActiveRun`'s own
                // `childRegistry` option.
                childRegistry: runOptions.childRegistry,
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
                      ...runningRef,
                      status: terminalStatus,
                    };
                    return {
                      ...freshSession,
                      ...(terminalConversation !== undefined
                        ? {
                            conversationHistory: appendConversationMessages(
                              freshSession.conversationHistory,
                              terminalConversation,
                              terminalConversation,
                            ),
                          }
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
            // Pass along `failures` accumulated from any NEWER running refs
            // that rejected before this (older) one succeeded — a mixed
            // outcome must still surface those rejections, not just the
            // all-fail case.
            emitter.dispatchEvent(new SessionRecoverEvent(sessionId, runId, failures));
            return agentRun;
          } catch (error) {
            // engine.resume() throws when the run is already terminal or the
            // engine doesn't have it, or when recovery itself is broken (e.g.
            // a malformed resolveWorkflowServices result). Reconcile the
            // persisted RunRef in the terminal case (AB-28) — otherwise it is
            // stranded at 'running' forever, and every later
            // recover()/signal()/update() targets a workflow that is already
            // dead. reconcileTerminalRunRef() is a no-op for an unknown runId
            // or a genuine (non-terminal) failure. Record which runId
            // rejected and why regardless — the caller learns about every
            // rejection via `failures` on the event dispatched below, not
            // just the last one — then try older running refs either way.
            try {
              await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, runningRef);
              failures.push({ runId, error });
            } catch (reconciliationError) {
              failures.push({ runId, error: reconciliationError });
            }
          }
        }
        if (failures.length > 0) {
          emitter.dispatchEvent(new SessionRecoverEvent(sessionId, null, failures));
          return null;
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
        : run
          ? undefined
          : newestRunningRunRef(cancelSession);
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
              if (runIndex < 0 || !runs[runIndex]) return undefined;
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
      if (parkedRunId === runId && parkedSignalName === name) {
        parkedRunId = undefined;
        parkedSignalName = undefined;
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
      if (currentRun !== null && currentRunId === null) {
        throw new NoRunningRunError('query', sessionId);
      }
      const target = currentRunId
        ? session?.runs.find((runRef) => runRef.runId === currentRunId)
        : (newestRunningRunRef(session) ?? session?.runs[session.runs.length - 1]);
      if (!target) {
        throw new NoRunningRunError('query', sessionId);
      }
      emitter.dispatchEvent(new SessionQueryEvent(sessionId, name, input));
      return eng.query(target.runId, name, input) as Promise<TResult>;
    },

    async monitor(options: MonitorOptions): Promise<boolean> {
      const { every, input, until, maxDuration, signal } = options;
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
      // `runtime.monotonic.now() - startedAt >= maxMs` is then ALWAYS false (every comparison
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

      const startedAt = runtime.monotonic.now();
      let tick = 0;

      // Liveness (AB-215): the `session.monitor` `StallPolicy` row (obs-01's
      // `policies.ts`) drives a watchdog for the lifetime of this loop only —
      // created here (its cadence is `everyMs`, only known now) and disposed
      // in `finally` below, so a session not currently being polled accrues
      // no missed pulses.
      sessionWatchdogCadenceMs = everyMs;
      sessionWatchdog = createStallWatchdog(sessionMonitorPolicy(everyMs), livenessClock, {
        onAssessmentChange: advanceLiveness,
      });

      try {
        while (true) {
          // Deadline guard — check before starting a new tick.
          if (maxMs !== undefined && runtime.monotonic.now() - startedAt >= maxMs) {
            emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
            return false;
          }

          // Emit tick-started (met = null — run hasn't completed yet).
          // Each tick is a full agent run. `'host-reachability'` specifically
          // (AB-215/AC3): a caller's own poll tick proves the process is
          // scheduling callbacks, not that the underlying watched work is
          // progressing.
          signal?.throwIfAborted();
          // Optional chaining: `sessionWatchdog` can be transiently paused
          // (undefined) by a `HumanWaitParkedEvent` from the PREVIOUS tick's
          // run racing this check — read the live reference each iteration
          // rather than a value captured before the loop started.
          sessionWatchdog?.recordPulse('host-reachability', 0);
          setLivenessState('running');
          emitter.dispatchEvent(new SessionMonitorTickEvent(sessionId, tick, null));
          const run = handle.run(input);
          const abortRun = () => run.abort('session monitor aborted');
          signal?.addEventListener('abort', abortRun, { once: true });
          let result: RunResult;
          try {
            result = await run.result();
          } catch (err) {
            // A run error is treated as a non-met tick — we emit done(false) and
            // propagate. The caller should handle this as an error condition.
            emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
            if (signal?.aborted) throw processLocalAbortError();
            throw err;
          } finally {
            signal?.removeEventListener('abort', abortRun);
          }

          // Surface terminal run FAILURES as errors instead of feeding them to the
          // predicate. `run.result()` resolves (it does not throw) for normal
          // operative failures — `error`, `aborted`, `budget-exceeded`,
          // `elicitation-denied` — so the catch above never runs for these. Without
          // this check a predicate that returns false would keep sleeping and
          // re-running after a provider/tool failure instead of surfacing it, the
          // same way the catch block does for thrown errors (PRRT_kwDORvupsc6MddwB).
          if (signal?.aborted) {
            emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
            throw processLocalAbortError();
          }
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
          const elapsed = runtime.monotonic.now() - startedAt;
          if (maxMs !== undefined && elapsed >= maxMs) {
            emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
            return false;
          }
          const remainingMs = maxMs !== undefined ? maxMs - elapsed : Infinity;
          const sleepMs = Math.min(everyMs, remainingMs);
          if (sleepMs > 0) {
            // Liveness: a bounded 'sleep' declared wait — unlike 'signal'/
            // 'review', AB-88 requires a deadline for this reason, and the
            // session.monitor watchdog stays live through it (its own
            // cadence check governs whether the next tick's pulse arrives
            // in time).
            setLivenessState('waiting', {
              reason: 'sleep',
              startedAt: livenessClock.now(),
              deadline: livenessClock.now() + sleepMs,
              wakeCondition: 'session.monitor inter-tick timer',
            });
            try {
              await processLocalDelay(sleepMs, signal, setTimeoutFunction, clearTimeoutFunction);
            } catch (error) {
              emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
              throw error;
            }
          }
        }
      } finally {
        sessionWatchdog?.dispose();
        sessionWatchdog = undefined;
        sessionWatchdogCadenceMs = undefined;
        setLivenessState('created');
      }
    },

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
