import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { type ActiveRun, createAgentSession, createRun, type JSONValue } from 'operative';
import {
  isAgentRunWorkflowInput,
  reattachDurableActiveRun,
  type RecoveredRunHandle,
} from 'operative/durable';
import {
  createStore,
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  type Store,
  StoreActionEvent,
} from 'sentinel';

import {
  ActionEvent,
  BureauDisposedEvent,
  type BureauEventMap,
  RunRegisteredEvent,
  RunRemovedEvent,
} from './events';
import { createRuntimeComposition } from './runtime-composition';
import {
  serializeActionDetail,
  serializeRunDetail,
  serializeRunState,
  serializeUnknownError,
} from './serialization';
import type {
  Bureau,
  BureauOptions,
  ConfigurationResponse,
  CreateRunRequest,
  RunSummary,
  ServerFrame,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
  ToolSummary,
} from './types';
import { streamEventToFrame } from './websocket/protocol';

const GATEWAY_AGENT_NAME = 'gateway';
const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;
const SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS = 10;
const SCHEDULER_PRIORITIES = ['immediate', 'scheduled', 'background', 'ambient'] as const;

class BureauError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' | 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'BureauError';
  }
}

export { BureauError };

function toBadRequest(message: string): never {
  throw new BureauError(message, 'BAD_REQUEST');
}

function validateMessageRequest(request: {
  message: unknown;
  maximumSteps?: unknown;
  systemPrompt?: unknown;
}): void {
  if (!request.message || typeof request.message !== 'string') {
    toBadRequest('Request must include a "message" string');
  }

  if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') {
    toBadRequest('"systemPrompt" must be a string');
  }

  if (request.maximumSteps !== undefined) {
    if (
      typeof request.maximumSteps !== 'number' ||
      !Number.isInteger(request.maximumSteps) ||
      request.maximumSteps <= 0
    ) {
      toBadRequest('"maximumSteps" must be a positive integer');
    }
  }
}

function validateCreateRunRequest(request: CreateRunRequest): void {
  validateMessageRequest(request);

  if (request.sessionId !== undefined) {
    if (typeof request.sessionId !== 'string') {
      toBadRequest('"sessionId" must be a string');
    }

    if (request.sessionId.trim().length === 0) {
      toBadRequest('"sessionId" must be a non-empty string');
    }
  }
}

function validateSubmitSchedulerTaskRequest(request: SubmitSchedulerTaskRequest): void {
  validateMessageRequest(request);

  if (request.metadata !== undefined) {
    if (
      typeof request.metadata !== 'object' ||
      request.metadata === null ||
      Array.isArray(request.metadata)
    ) {
      toBadRequest('"metadata" must be an object');
    }
  }

  if (request.priority !== undefined && !SCHEDULER_PRIORITIES.includes(request.priority)) {
    toBadRequest('"priority" must be one of: immediate, scheduled, background, ambient');
  }

  if (request.requeue !== undefined && typeof request.requeue !== 'boolean') {
    toBadRequest('"requeue" must be a boolean');
  }
}

/**
 * The session metadata boot recovery needs to decide a recovered run's fate,
 * loaded by id from the owning session. `null` ⇒ the session does not exist.
 */
export type RecoveredRunSessionMetadata = { lastRunId?: unknown; lastRunStatus?: unknown } | null;

/**
 * The outcome of loading a recovered run's owning session: a successful load
 * (the metadata, possibly `null` for "absent") or a transient read FAILURE that
 * leaves ownership UNKNOWN.
 */
export type SessionLoadOutcome = { ok: true; session: RecoveredRunSessionMetadata } | { ok: false };

/**
 * Decide what boot recovery does with one handle from `engine.recoverAll()`:
 *
 * - `reattach` — bureau-owned, in-flight, session-confirmed: wrap it in a live
 *   ActiveRun and register it.
 * - `cancel` — POSITIVELY not a reattachable bureau-owned in-flight run (bad/
 *   missing launch metadata, foreign run id, or a session that is absent / owns a
 *   different run / is already terminal). `engine.cancel` terminalizes it so it
 *   does not run unowned with no monitor.
 * - `skip` — ownership could NOT be confirmed (a transient session-load failure,
 *   or no session store): do NOTHING. `engine.cancel` is terminal, so we never
 *   cancel a run that may be legitimately recovering — the worst case is it
 *   resumes without live `getRun` visibility (the pre-#3 behaviour).
 *
 * Pure (no I/O) so every branch is unit-testable. `recoverAll()` fires the
 * services resolver synchronously per run before returning, and the resolver
 * reconciles a deps-unrebuildable run's session to `lastRunStatus: 'error'` — so
 * by the time this classifies, a session still `'running'` is one the resolver
 * kept. The gate is on SESSION status, NOT engine run-status: a run that
 * resolved-and-finished fast during `recoverAll` is terminal in the engine but its
 * session is still `'running'` (its monitor has not written yet), and it must
 * still be reattached so its completion is persisted.
 */
export function classifyRecoveredRun(args: {
  handleId: string;
  /** The narrowed agentRun input when the launch metadata is bureau-owned, else `undefined`. */
  ownedSessionId: string | undefined;
  /** Whether reading the handle's launch metadata threw. */
  metadataReadFailed: boolean;
  /** A session store is configured (recovery cannot reattach without one). */
  hasSessionStore: boolean;
  /** The session-load outcome; only meaningful when `ownedSessionId` is set + `hasSessionStore`. */
  sessionLoad: SessionLoadOutcome;
}): 'reattach' | 'cancel' | 'skip' {
  // A failed metadata read means we cannot even identify the run — but it WAS
  // resumed by recoverAll, so cancel it rather than leave it unowned.
  if (args.metadataReadFailed) return 'cancel';
  // Not a bureau-owned agentRun (foreign run id / non-agentRun input) — cancel.
  if (args.ownedSessionId === undefined) return 'cancel';
  // Owned input but no session store to confirm against / reattach into — skip.
  if (!args.hasSessionStore) return 'skip';
  // Transient session-load failure — ownership UNKNOWN, never cancel; skip.
  if (!args.sessionLoad.ok) return 'skip';
  const session = args.sessionLoad.session;
  // Session absent / owns a different run / not in-flight — positively unowned.
  if (!session || session.lastRunId !== args.handleId || session.lastRunStatus !== 'running') {
    return 'cancel';
  }
  return 'reattach';
}

export async function createBureau(options: BureauOptions = {}): Promise<Bureau> {
  const ownsStore = !options.store;
  const store: Store = options.store ?? createStore();
  const emitter = new CompletableEventTarget<BureauEventMap>();
  // Tracks whether dispose() has run, so a second call is a safe no-op (closing
  // an already-closed SQLite handle is runtime-dependent).
  let disposed = false;
  const runtime = await createRuntimeComposition(options);
  const runSessionIdentifiers = new WeakMap<ActiveRun, string>();
  const liveFrameListeners = new Set<(frame: ServerFrame) => void>();
  const sessionPersistenceRetryDelayMilliseconds =
    options.sessionPersistenceRetryDelayMilliseconds ??
    SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS;
  const sessionPersistenceSleep =
    options.sessionPersistenceSleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  function getRunSessionIdentifier(runState: { activeRun: ActiveRun }): string {
    return runSessionIdentifiers.get(runState.activeRun) ?? '';
  }

  function emitLiveFrame(frame: ServerFrame): void {
    for (const listener of liveFrameListeners) {
      listener(frame);
    }
  }

  const storeSubscription = store.toObservable().subscribe((event) => {
    switch (event.type) {
      case 'action': {
        const storeActionEvent = event as StoreActionEvent;
        emitter.dispatch(new ActionEvent(storeActionEvent.action));
        emitLiveFrame({
          type: 'event',
          runId: storeActionEvent.action.runId,
          event: storeActionEvent.action.type,
          detail: serializeActionDetail(
            storeActionEvent.action.type,
            storeActionEvent.action.detail,
          ),
          sequence: storeActionEvent.action.sequence,
          timestamp: storeActionEvent.action.timestamp,
        });
        break;
      }
      case 'run.registered':
        emitter.dispatch(new RunRegisteredEvent((event as StoreRunRegisteredEvent).runId));
        break;
      case 'run.removed':
        emitter.dispatch(new RunRemovedEvent((event as StoreRunRemovedEvent).runId));
        break;
    }
  });

  const schedulerEventTypes = [
    'task.queued',
    'task.dispatched',
    'task.completed',
    'task.failed',
    'task.preempted',
    'task.cancelled',
    'scheduler.idle',
    'scheduler.started',
    'scheduler.stopped',
  ] as const;

  const schedulerCleanup =
    runtime.scheduler === undefined
      ? []
      : schedulerEventTypes.map((eventType) => {
          const listener = (event: Event) => {
            if (eventType === 'task.preempted') {
              const preemptedEvent = event as Event & { taskId: string; reason: string };
              emitLiveFrame({
                type: 'scheduler.task.preempted',
                taskId: preemptedEvent.taskId,
                reason: preemptedEvent.reason,
                state: runtime.scheduler!.getState(),
              });
              return;
            }

            emitLiveFrame({
              type: 'scheduler.state',
              state: runtime.scheduler!.getState(),
            });
          };

          runtime.scheduler!.addEventListener(eventType, listener);
          return () => runtime.scheduler?.removeEventListener(eventType, listener);
        });

  function requireSessionStore() {
    if (!runtime.sessionStore) {
      throw new BureauError(
        'No SessionStore configured (set options.persistence or options.storage)',
        'NOT_IMPLEMENTED',
      );
    }

    return runtime.sessionStore;
  }

  async function loadConversation(sessionId: string) {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    const session = await sessionStore.load(sessionId);
    if (!session) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    return {
      session,
      conversation: new Conversation(session.conversationHistory),
    };
  }

  async function saveSession(
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
  ): Promise<void> {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) {
      return;
    }

    const existingSession = await sessionStore.load(sessionId);
    const nextSession =
      existingSession ??
      createAgentSession({
        id: sessionId,
        agentName: GATEWAY_AGENT_NAME,
        conversationHistory: conversation.current,
      });

    await sessionStore.save({
      ...nextSession,
      conversationHistory: conversation.current,
      metadata: {
        ...nextSession.metadata,
        ...metadata,
      },
    });
  }

  function persistSessionUpdate(
    saveSessionUpdate: () => Promise<void>,
    context: { runId: string; sessionId: string; status: 'completed' | 'error' | 'aborted' },
  ): void {
    void (async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          await saveSessionUpdate();
          return;
        } catch (error) {
          lastError = error;

          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            try {
              await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
            } catch (sleepError) {
              lastError = sleepError;
              break;
            }
          }
        }
      }

      console.warn(
        `[bureau] Failed to persist ${context.status} session state for run ${context.runId} in session ${context.sessionId}: ${serializeUnknownError(lastError)}`,
      );
    })();
  }

  function disposeRegisteredStreamListeners(listeners: Array<() => void>): void {
    while (listeners.length > 0) {
      const disposeListener = listeners.pop();
      disposeListener?.();
    }
  }

  async function createRunFromRequest(request: CreateRunRequest): Promise<RunSummary> {
    validateCreateRunRequest(request);

    if (!runtime.ready) {
      throw new BureauError('No generate function configured', 'NOT_CONFIGURED');
    }

    const sessionId = request.sessionId?.trim() ?? crypto.randomUUID();
    const { session, conversation } = await loadConversation(sessionId);

    if (!session) {
      const prompt = request.systemPrompt ?? runtime.systemPrompt;
      if (prompt) {
        conversation.appendSystemMessage(prompt);
      }
    }

    conversation.appendUserMessage(request.message);

    const runId = `run-${crypto.randomUUID()}`;
    const runRuntime = await runtime.createRunRuntime({
      ...request,
      sessionId,
    });

    const disposeStreamListeners: Array<() => void> = [];
    const streamEventTarget = runRuntime.streamEventTarget;
    if (streamEventTarget) {
      const streamEventTypes = [
        'stream:text-delta',
        'stream:tool-call-start',
        'stream:tool-call-delta',
        'stream:tool-call-complete',
        'stream:complete',
        'stream:error',
      ] as const;

      for (const eventType of streamEventTypes) {
        const listener = (event: Event) => {
          const detail = (event as Event & { detail: Parameters<typeof streamEventToFrame>[1] })
            .detail;
          const frame = streamEventToFrame(runId, detail);
          if (frame) {
            emitLiveFrame(frame);
          }
        };

        streamEventTarget.addEventListener(eventType, listener);
        disposeStreamListeners.push(() =>
          streamEventTarget.removeEventListener(eventType, listener),
        );
      }
    }

    await saveSession(sessionId, conversation, {
      lastRunId: runId,
      lastRunStatus: 'running',
      lastUserMessage: request.message,
    });

    const activeRun = createRun(
      {
        generate: runRuntime.generate,
        toolbox: runRuntime.toolbox,
        conversation,
        maximumSteps: request.maximumSteps ?? runtime.maximumSteps,
        stopWhen: options.stopWhen,
        prepareStep: runRuntime.prepareStep,
        onStep: runRuntime.onStep,
        validateResponse: runRuntime.validateResponse,
      },
      // Route through the durable engine when one was composed (durableExecution
      // + storage). The conversation already carries the seeded user/system
      // messages, so no separate `prompt` is passed — the workflow snapshots it.
      // The run is then checkpointed and resumes from its last step after a crash.
      runtime.durable
        ? {
            engine: runtime.durable.engine,
            checkpointStore: runtime.durable.checkpointStore,
            runId,
            // Carry the owning session in the durable input so boot recovery can
            // correlate a recovered handle back to its session without a side
            // table (see recoverDurableRuns / resolveRunServices).
            sessionId,
          }
        : undefined,
    );

    activeRun.once('run.completed', (event) => {
      disposeRegisteredStreamListeners(disposeStreamListeners);

      const lastRunStatus = event.finishReason === 'error' ? 'error' : 'completed';

      persistSessionUpdate(
        () =>
          saveSession(sessionId, event.conversation, {
            lastRunId: runId,
            lastRunStatus,
            lastFinishReason: event.finishReason,
            ...(event.finishReason === 'error'
              ? { lastError: serializeUnknownError(event.error) }
              : {}),
          }),
        {
          runId,
          sessionId,
          status: lastRunStatus,
        },
      );
    });

    activeRun.once('run.aborted', () => {
      disposeRegisteredStreamListeners(disposeStreamListeners);

      persistSessionUpdate(
        () =>
          saveSession(sessionId, conversation, {
            lastRunId: runId,
            lastRunStatus: 'aborted',
            // Write lastFinishReason too so an aborted session's metadata is
            // internally consistent (status + finishReason agree) and a prior
            // run's stale lastFinishReason on the same session can't linger. This
            // is also what boot recovery now relies on: a recovered run that
            // aborts settles through THIS listener (settleRecoveredRun is gone),
            // so the field must be written here, not only on the old recovery path.
            lastFinishReason: 'aborted',
          }),
        {
          runId,
          sessionId,
          status: 'aborted',
        },
      );
    });

    activeRun.once('run.error', (_event) => {
      disposeRegisteredStreamListeners(disposeStreamListeners);
    });

    store.register(activeRun, runId);
    runSessionIdentifiers.set(activeRun, sessionId);

    return serializeRunState(store.getRun(runId)!, sessionId);
  }

  /**
   * Reattach one run RECOVERED by `engine.recoverAll()` to the live surface
   * (closes seam #5b). Builds a {@link reattachDurableActiveRun} adapter over the
   * already-running handle, wires the SAME terminal session-persistence listeners
   * the live-run path uses (so a recovered run's `getRun(...)` + session status
   * behave exactly like a never-crashed one), and `store.register`s it.
   *
   * Synchronous by construction (no `await` before `store.register`): the adapter
   * defers its `handle.result()` await onto a microtask, so registration +
   * `runSessionIdentifiers.set` complete in this turn BEFORE any terminal event
   * fires — even for a handle that already settled. So `getRun(runId)` resolves
   * the instant this returns and no subscriber misses the terminal event.
   *
   * Idempotent: skips a `runId` already live on this process (the store uses a
   * plain `Map.set`, which would silently overwrite + split-brain a double
   * register). `recoverDurableRuns` is itself boot-single-shot; this is defense.
   */
  function reattachRecoveredRun(
    runId: string,
    sessionId: string,
    handle: RecoveredRunHandle,
  ): void {
    // At-most-once registration per runId (guards double-recover / a runId already
    // started live on this process — neither should reach here, but a silent
    // Map.set overwrite would be a split-brain, so cheap-guard it).
    if (store.getRun(runId)) return;

    const recoveredRun = reattachDurableActiveRun(
      { engine: runtime.durable!.engine, checkpointStore: runtime.durable!.checkpointStore },
      { runId, handle },
    );

    // Persist terminal session status from the recovered run's OWN terminal
    // events — the same fields the live-run listeners write. The conversation
    // comes from `event.conversation`, which the reattach adapter reconstructs
    // from the checkpoint (so completed steps from the resumed process are
    // included), preserving the old `settleRecoveredRun`'s checkpoint-preferred
    // conversation behavior. A run the engine failed pre-replay (services
    // unavailable) or one interrupted by teardown fires NO terminal event — the
    // adapter stays write-free for those and the resolver/teardown owns the
    // session status; so these listeners only run for a genuinely settled run.
    recoveredRun.once('run.completed', (event) => {
      const lastRunStatus = event.finishReason === 'error' ? 'error' : 'completed';
      persistSessionUpdate(
        () =>
          saveSession(sessionId, event.conversation, {
            lastRunId: runId,
            lastRunStatus,
            lastFinishReason: event.finishReason,
            ...(event.finishReason === 'error'
              ? { lastError: serializeUnknownError(event.error) }
              : {}),
          }),
        { runId, sessionId, status: lastRunStatus },
      );
    });

    recoveredRun.once('run.aborted', () => {
      persistSessionUpdate(
        // RunAbortedEvent carries no conversation (unlike run.completed), so load
        // the transcript from the run's final checkpoint — the same
        // checkpoint-preferred conversation the old settleRecoveredRun persisted.
        async () => {
          const snapshot = await runtime.durable?.checkpointStore.loadConversation(runId);
          const conversation = snapshot ? Conversation.from(snapshot) : new Conversation();
          await saveSession(sessionId, conversation, {
            lastRunId: runId,
            lastRunStatus: 'aborted',
            lastFinishReason: 'aborted',
          });
        },
        { runId, sessionId, status: 'aborted' },
      );
    });

    store.register(recoveredRun, runId);
    runSessionIdentifiers.set(recoveredRun, sessionId);
  }

  /**
   * Boot-time recovery for durable runs (seams #2, #3/#5b, #5). Resumes any
   * `agentRun` workflows a previous process left in flight via
   * `engine.recoverAll()` and REATTACHES each as a live `ActiveRun`.
   *
   * #2 — no side table. Each recovered run's owning session is read from the
   * handle's own launch metadata (`handle.getLaunchMetadata().input.sessionId`,
   * which the run carried in its durable input), not from a pre-built
   * runId→sessionId scan of the session store. The deps a recovered run needs are
   * re-provided lazily by the engine's `resolveWorkflowServices` resolver
   * (`resolveRunServices`) before its generator advances — no pre-injection, no
   * module-global registry.
   *
   * #3/#5b — live visibility. Each recovered handle is wrapped in a
   * {@link reattachRecoveredRun} adapter and `store.register`d, so the resumed run
   * rejoins `getRun(...)` and the live subscriber surface and its terminal session
   * status is persisted from its own lifecycle events. (Per-step events during
   * resume are not forwarded — see `reattachDurableActiveRun`'s contract.)
   *
   * Boot returns once `recoverAll()` has STARTED the handles and they are
   * registered, not when they complete: a recovered run that resumes into a long
   * model call must not hold the gateway hostage. Each adapter awaits its result
   * detached.
   *
   * Fail-safe: a run whose deps the resolver cannot rebuild is failed terminally
   * by the engine BEFORE replay (the resolver reconciles its session to `error`
   * synchronously, with the sessionId in hand); its reattached handle then rejects
   * and the adapter stays write-free, so the resolver's status is authoritative.
   * A run whose launch metadata lacks a `sessionId` (checkpointed before #2, or
   * not bureau-owned) is skipped — there is no compatibility fallback for
   * cross-upgrade in-flight runs.
   *
   * KNOWN SEAM — durable scheduler runs (#7b) are NOT cross-process recoverable.
   * A durable scheduler task (durable scheduler enabled) runs as an `agentRun`
   * workflow in this SAME engine with `sessionId === runId` (a synthetic
   * `scheduler-run-…` id), and the durable run path does NOT write a session
   * record (only the gateway's interactive `runDurable` path persists sessions).
   * So if the process crashes with a scheduler run in flight, `recoverAll()`
   * surfaces it here, but `resolveRunServices` finds no session for its synthetic
   * id → returns `unavailable` → the engine fails it clean before replay. The
   * reattached handle then rejects and the adapter stays write-free. Net: scheduler
   * durable runs are SAME-PROCESS suspend/resume only (their value — preemption
   * preserves progress within a live process); they surface briefly on recovery
   * and fail clean rather than resuming. This is intentional, not a gap:
   * cross-process recovery of scheduler tasks would require persisting a session
   * per task, which the in-process scheduler deliberately does not do.
   */
  async function recoverDurableRuns(): Promise<void> {
    if (!runtime.durable) return;
    if (!runtime.sessionStore) return;

    const durable = runtime.durable;

    // recoverAll resumes the in-flight workflows (firing the services resolver per
    // run before each generator advances); if it throws, the boot try/catch logs
    // and continues.
    const handles = await durable.engine.recoverAll();

    // Read each handle's launch metadata CONCURRENTLY, so one slow/stuck read does
    // not block registration of the rest (no head-of-line blocking). The read is
    // caught PER HANDLE so the resolved value always carries the handle identity —
    // a rejected read must not lose the handle, or we could not cancel the
    // now-resumed-but-unidentifiable run (committee round-2 finding 1). Then
    // reattach each owned handle SYNCHRONOUSLY in one turn, preserving the
    // register-before-terminal-event ordering invariant.
    const resolved = await Promise.all(
      handles.map(async (handle) => {
        try {
          return { handle, metadata: await handle.getLaunchMetadata() };
        } catch (error) {
          return { handle, metadata: null, error };
        }
      }),
    );

    const orphanCancellations: Array<{ runId: string; cancel: Promise<void> }> = [];
    const sessionStore = runtime.sessionStore;
    for (const { handle, metadata, ...rest } of resolved) {
      const readError = 'error' in rest ? rest.error : undefined;
      if (readError !== undefined) {
        console.error(
          `[bureau] Could not read launch metadata for recovered run "${handle.id}"; cancelling: ${serializeUnknownError(readError)}`,
        );
      }

      // A run is bureau-owned only if its launch metadata narrows to an agentRun
      // input AND its input runId matches this handle's id (the workflow id is the
      // run id).
      const ownedSessionId =
        readError === undefined &&
        metadata &&
        isAgentRunWorkflowInput(metadata.input) &&
        metadata.input.runId === handle.id
          ? metadata.input.sessionId
          : undefined;

      // Load the owning session (only meaningful for an owned run with a store).
      // A throw leaves ownership UNKNOWN — classifyRecoveredRun then skips rather
      // than cancels, so a transient read blip never terminates a legitimately
      // recovering run.
      let sessionLoad: SessionLoadOutcome = { ok: true, session: null };
      if (ownedSessionId !== undefined && sessionStore) {
        try {
          const session = await sessionStore.load(ownedSessionId);
          sessionLoad = { ok: true, session: session ? { ...session.metadata } : null };
        } catch (error) {
          console.error(
            `[bureau] Could not load owning session for recovered run "${handle.id}"; leaving it to resume without live visibility: ${serializeUnknownError(error)}`,
          );
          sessionLoad = { ok: false };
        }
      }

      const verdict = classifyRecoveredRun({
        handleId: handle.id,
        ownedSessionId,
        metadataReadFailed: readError !== undefined,
        hasSessionStore: sessionStore !== undefined,
        sessionLoad,
      });

      if (verdict === 'reattach') {
        // ownedSessionId is defined when the verdict is 'reattach'.
        reattachRecoveredRun(handle.id, ownedSessionId!, handle);
      } else if (verdict === 'cancel') {
        // Collect the cancel (do NOT fire-and-forget swallow): a rejected cancel
        // could leave an unowned, already-resumed run live with no monitor, so its
        // failure must be surfaced for operators. engine.cancel terminalizes the
        // run and rejects its waiter — covering metadata-less / read-failed /
        // foreign-input / orphaned-session residue without store.register'ing it.
        orphanCancellations.push({ runId: handle.id, cancel: durable.engine.cancel(handle.id) });
      }
      // 'skip' — ownership unknown; leave the run to resume without live visibility.
    }

    // Await the orphan cancels DETACHED — boot must not block on them (same as the
    // recovered-run monitors), but a cancel that REJECTS leaves an unowned run
    // running, which is an operator-actionable failure, not something to swallow.
    if (orphanCancellations.length > 0) {
      void Promise.allSettled(orphanCancellations.map(({ cancel }) => cancel)).then((outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.status === 'rejected') {
            console.error(
              `[bureau] Failed to cancel unowned recovered run "${orphanCancellations[index]!.runId}" — it may still be running: ${serializeUnknownError(outcome.reason)}`,
            );
          }
        });
      });
    }
  }

  function submitSchedulerTask(
    request: SubmitSchedulerTaskRequest,
  ): Promise<SubmitSchedulerTaskResponse> {
    validateSubmitSchedulerTaskRequest(request);

    if (!runtime.scheduler) {
      throw new BureauError('Scheduler not configured', 'NOT_CONFIGURED');
    }

    const taskId = `scheduler-task-${crypto.randomUUID()}`;
    const priority = request.priority ?? 'scheduled';

    const task: Parameters<NonNullable<typeof runtime.scheduler>['submit']>[0] = {
      id: taskId,
      priority,
      metadata: request.metadata,
      requeue: request.requeue,
      async createRun() {
        const runRuntime = await runtime.createRunRuntime(
          {
            message: request.message,
            maximumSteps: request.maximumSteps,
            systemPrompt: request.systemPrompt,
            sessionId: taskId,
          },
          { liveStreaming: false },
        );

        const conversation = new Conversation(createConversationHistory({ id: taskId }));
        const systemPrompt = request.systemPrompt ?? runtime.systemPrompt;
        if (systemPrompt) {
          conversation.appendSystemMessage(systemPrompt);
        }
        conversation.appendUserMessage(request.message);

        return {
          conversation,
          generate: runRuntime.generate,
          toolbox: runRuntime.toolbox,
          maximumSteps: request.maximumSteps ?? runtime.maximumSteps,
          onStep: runRuntime.onStep,
          prepareStep: runRuntime.prepareStep,
          stopWhen: options.stopWhen,
          validateResponse: runRuntime.validateResponse,
        };
      },
    };

    void runtime.scheduler.submit(task).catch(() => {});

    return Promise.resolve({
      taskId,
      priority,
      status: 'queued',
    });
  }

  function listRuns(status?: string): RunSummary[] {
    const state = store.getState();
    const summaries: RunSummary[] = [];

    for (const [, runState] of state.runs) {
      if (status && runState.status !== status) {
        continue;
      }

      const sessionId = getRunSessionIdentifier(runState);
      summaries.push(serializeRunState(runState, sessionId));
    }

    return summaries;
  }

  function getRun(id: string) {
    const runState = store.getRun(id);
    if (!runState) {
      return undefined;
    }

    return serializeRunDetail(runState, getRunSessionIdentifier(runState));
  }

  function abortRun(id: string): RunSummary {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    if (runState.status !== 'running') {
      throw new BureauError(`Run is already ${runState.status}`, 'CONFLICT');
    }

    runState.activeRun.abort('Aborted via API');
    return {
      ...serializeRunState(runState, getRunSessionIdentifier(runState)),
      status: 'aborted',
    };
  }

  function deleteRun(id: string): void {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    if (runState.status === 'running') {
      throw new BureauError('Cannot delete a running run', 'CONFLICT');
    }

    runSessionIdentifiers.delete(runState.activeRun);
    store.removeRun(id);
  }

  async function listSessions() {
    return requireSessionStore().list();
  }

  async function getSession(id: string) {
    return requireSessionStore().load(id);
  }

  async function deleteSession(id: string): Promise<void> {
    await requireSessionStore().delete(id);
  }

  function getToolSummaries(): ToolSummary[] {
    return runtime.getToolSummaries();
  }

  function getConfiguration(): ConfigurationResponse {
    return {
      provider: runtime.provider,
      providers: runtime.providers,
      maximumSteps: runtime.maximumSteps,
      systemPrompt: runtime.systemPrompt,
      tools: getToolSummaries(),
    };
  }

  function dispose(): void {
    // Idempotency guard: dispose() may be called more than once (the harness
    // does in tests, and `[Symbol.dispose]` may re-enter). Disposing the engine
    // and especially the raw Storage twice can close an already-closed SQLite
    // connection; a second pass is a no-op.
    if (disposed) return;
    disposed = true;

    // All pre-teardown is BEST-EFFORT, and the whole body is under an OUTER
    // try/finally so the critical backend teardown (engine → storage → store)
    // ALWAYS runs. The async steps (`scheduler.stop`, `memory.close`) are
    // already `.catch`'d; the synchronous steps below are equally fallible —
    // `emitter.dispatch`/`emitter.complete` route through
    // `CompletableEventTarget.dispatchEvent`, which loops over `toObservable()`
    // subscribers WITHOUT a try/catch, so a subscriber whose `next`/`complete`
    // throws propagates straight back here. That path is reachable through the
    // public Bureau surface (`toObservable()`), so the synchronous pre-teardown
    // is wrapped to swallow-and-log: a throwing subscriber must not strand the
    // SQLite/LMDB handle behind the now-`true` `disposed` guard (a second
    // dispose no-ops), leaking it permanently. Covered by the
    // "toObservable subscriber throws during dispose" regression test.
    try {
      if (runtime.scheduler) {
        void runtime.scheduler.stop().catch(() => {});
      }

      if (runtime.memory) {
        void runtime.memory.close().catch(() => {});
      }

      try {
        emitter.dispatch(new BureauDisposedEvent());
        storeSubscription.unsubscribe();
        for (const disposeListener of schedulerCleanup) {
          disposeListener();
        }
        emitter.complete();
      } catch (error) {
        console.error(
          `[bureau] Error during dispose pre-teardown: ${serializeUnknownError(error)}`,
        );
      }
    } finally {
      // The per-run `resolveWorkflowServices` resolver is engine-scoped and is
      // released when the engine is disposed below — there is no module-global
      // reconstructor to clear here anymore.
      //
      // Dispose the durable run engine, then the raw Storage, then the store —
      // each guarded so a throw in one stage does not skip the next (engine
      // dispose is synchronous and can throw in a degraded environment; the
      // SQLite/LMDB handle must still be released).
      //
      // Durable execution is ON BY DEFAULT for a persistent storage backend, so
      // most sqlite/lmdb bureaus now own an engine. The engine dispose does NOT
      // close the raw Storage, and the KV/checkpoint views were created with
      // `disposeUnderlyingStorage: false` — so the explicit `disposeStorage` is
      // what actually releases the file handle (even when no engine was built,
      // e.g. `durableExecution: false` with sqlite).
      try {
        runtime.durable?.engine[Symbol.dispose]?.();
      } finally {
        try {
          runtime.disposeStorage?.();
        } finally {
          if (ownsStore) {
            store.dispose();
          }
        }
      }
    }
  }

  // Resume any durable runs a previous process left in flight. Best-effort: a
  // recovery failure is logged but never blocks bringing the bureau up.
  try {
    await recoverDurableRuns();
  } catch (error) {
    console.error(
      `[bureau] Durable run recovery failed during boot: ${serializeUnknownError(error)}`,
    );
  }

  return {
    store,
    memory: runtime.memory,
    scheduler: runtime.scheduler,
    sessionStore: runtime.sessionStore,
    kv: runtime.kv,
    get ready() {
      return runtime.ready;
    },
    createRun: createRunFromRequest,
    submitSchedulerTask,
    listRuns,
    getRun,
    abortRun,
    deleteRun,
    listSessions,
    getSession,
    deleteSession,
    getConfiguration,
    getTools: getToolSummaries,
    subscribeLiveFrames(listener) {
      liveFrameListeners.add(listener);
      return () => {
        liveFrameListeners.delete(listener);
      };
    },
    addEventListener: (type, listener, listenerOptions) =>
      emitter.addEventListener(type, listener, listenerOptions),
    removeEventListener: (type, listener, listenerOptions) =>
      emitter.removeEventListener(type, listener, listenerOptions),
    on: (type, observableOptions) => emitter.on(type, observableOptions),
    once: (type, listener) => emitter.once(type, listener),
    subscribe: (type, observerOrNext, error, complete) =>
      emitter.subscribe(type, observerOrNext, error, complete),
    toObservable: () => emitter.toObservable(),
    events: (type, iteratorOptions) => emitter.events(type, iteratorOptions),
    complete: () => emitter.complete(),
    get completed() {
      return emitter.completed;
    },
    get signal() {
      return emitter.signal;
    },
    dispose,
  } satisfies Bureau;
}
