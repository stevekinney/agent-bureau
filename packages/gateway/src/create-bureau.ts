import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { type ActiveRun, createAgentSession, createRun, type JSONValue } from 'operative';
import {
  clearRunDeps,
  type DurableRunDeps,
  registerRunDeps,
  setRunDepsReconstructor,
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
   * Rebuild a recovered run's non-serializable behavior from durable config.
   * Given a `runId`, find the session that owns it (its `lastRunId` while still
   * `running`) and reconstruct the run runtime from that session's persisted
   * request — the same `createRunRuntime` a fresh run uses. Returns `null` when
   * no such session exists (the run is not bureau-owned / not reconstructable),
   * so the durable workflow terminates it safely instead of bricking the engine.
   *
   * The reconstructed `conversation` is a placeholder: a resumed run reads its
   * transcript from the checkpoint, not from `options.conversation`.
   */
  async function buildRunDepsFromSession(
    session: Awaited<ReturnType<NonNullable<typeof runtime.sessionStore>['load']>>,
  ): Promise<DurableRunDeps | null> {
    if (!session) return null;
    const message = session.metadata['lastUserMessage'];
    const runRuntime = await runtime.createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
      },
      { liveStreaming: false },
    );
    return {
      toolbox: runRuntime.toolbox,
      options: {
        generate: runRuntime.generate,
        toolbox: runRuntime.toolbox,
        conversation: new Conversation(session.conversationHistory),
        maximumSteps: runtime.maximumSteps,
        stopWhen: options.stopWhen,
        prepareStep: runRuntime.prepareStep,
        onStep: runRuntime.onStep,
        validateResponse: runRuntime.validateResponse,
      },
    };
  }

  async function reconstructDurableRunDeps(runId: string): Promise<DurableRunDeps | null> {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) return null;

    const summaries = await sessionStore.list();
    for (const summary of summaries) {
      if (summary.metadata['lastRunId'] !== runId) continue;
      if (summary.metadata['lastRunStatus'] !== 'running') continue;
      const session = await sessionStore.load(summary.id);
      return buildRunDepsFromSession(session);
    }
    return null;
  }

  /**
   * Await one recovered handle to completion, persist the owning session's
   * terminal status, and release that run's deps. Runs detached, AFTER boot —
   * never awaited by `recoverDurableRuns`, so one long or stuck recovered run
   * cannot block the gateway from coming up.
   *
   * `runId` is taken from `handle.id` (the workflow id is pinned to the run id
   * at `engine.start`), so it is known BEFORE awaiting the result — the `finally`
   * therefore clears the credential-bearing closure UNCONDITIONALLY, even when
   * `handle.result()` rejects (e.g. `EngineDisposedError` on bureau teardown).
   * A rejection leaves the session `running` for a future process to retry,
   * matching the dispose-mid-run crash semantic.
   */
  async function settleRecoveredRun(
    handle: { id: string; result(): Promise<unknown> },
    recovered: ReadonlyMap<string, string>,
    sessionStore: NonNullable<typeof runtime.sessionStore>,
  ): Promise<void> {
    const runId = handle.id;
    try {
      const summary = (await handle.result()) as {
        runId?: unknown;
        finishReason?: unknown;
        errorMessage?: unknown;
      };
      const sessionId = recovered.get(runId);
      if (sessionId === undefined) return; // not bureau-owned; nothing to persist

      const session = await sessionStore.load(sessionId);
      if (!session) return;

      const finishReason =
        typeof summary.finishReason === 'string' ? summary.finishReason : 'error';
      // Match the live-run status mapping: only a plain 'error' maps to 'error';
      // 'aborted' maps to 'aborted' (not 'completed'); all other finish reasons
      // (stop-condition, max-steps, budget-exceeded, etc.) map to 'completed'.
      const lastRunStatus =
        finishReason === 'error' ? 'error' : finishReason === 'aborted' ? 'aborted' : 'completed';

      // Prefer the conversation snapshot written by the durable run's final
      // checkpoint (steps completed on the resumed process are there, not in the
      // session store which was last written before the crash). Fall back to the
      // session store conversation only when no checkpoint snapshot is available.
      const checkpointSnapshot = await runtime.durable?.checkpointStore.loadConversation(runId);
      const conversation = checkpointSnapshot
        ? Conversation.from(checkpointSnapshot)
        : new Conversation(session.conversationHistory);

      // Carry errorMessage → lastError for error-class finish reasons, matching
      // the live-run path (run.completed sets lastError when finishReason is error,
      // budget-exceeded, or elicitation-denied — i.e. whenever errorMessage is set).
      const metadata: Record<string, string> = {
        lastRunId: runId,
        lastRunStatus,
        lastFinishReason: finishReason,
      };
      if (typeof summary.errorMessage === 'string') {
        metadata['lastError'] = summary.errorMessage;
      }

      await saveSession(sessionId, conversation, metadata);
    } catch (error) {
      console.error(
        `[bureau] Recovered durable run "${runId}" did not settle cleanly: ${serializeUnknownError(error)}`,
      );
    } finally {
      clearRunDeps(runId);
    }
  }

  /**
   * Boot-time recovery for durable runs (seam #5). Registers the deps
   * reconstructor, pre-injects deps for in-flight runs, then resumes any
   * `agentRun` workflows a previous process left in flight via
   * `engine.recoverAll()`. Each recovered run advances to completion through the
   * reconstructed behavior; its terminal session status is persisted by a
   * DETACHED monitor so a resumed run is not stuck `running` forever — without
   * blocking boot on the run finishing.
   *
   * Boot returns once `recoverAll()` has STARTED the handles, not when they
   * complete: a recovered run that resumes into a long model call or a hanging
   * tool must not hold the whole gateway hostage. The per-handle monitors run
   * after this function returns and clear their deps in a `finally`.
   *
   * Best-effort and fail-safe: a single unrecoverable run terminates itself
   * (safe error result) without aborting the others or the boot.
   *
   * TODO(weft-integration): #5b reconstructed runs complete without an ActiveRun
   *   adapter, so they are not individually observable via the live event surface
   *   (their session status IS persisted). Reattaching ActiveRun + store.register
   *   per recovered handle is the remaining visibility half.
   */
  async function recoverDurableRuns(): Promise<void> {
    if (!runtime.durable) return;

    const sessionStore = runtime.sessionStore;
    if (!sessionStore) return;

    // PRE-INJECT, then recoverAll. Weft replays a recovered workflow from the
    // top, replaying cached activity results — so the in-workflow `ensureDeps`
    // activity returns its pre-crash cached value and does NOT re-invoke the
    // reconstructor on resume. The deps must therefore already be in the registry
    // before recoverAll resumes the generators. We also register the reconstructor
    // as a fallback for any run that crashed before its session recorded it.
    setRunDepsReconstructor(reconstructDurableRunDeps);

    const summaries = await sessionStore.list();
    const inFlight = summaries.filter((summary) => summary.metadata['lastRunStatus'] === 'running');
    const recovered = new Map<string, string>(); // runId -> sessionId
    for (const summary of inFlight) {
      const runId = summary.metadata['lastRunId'];
      if (typeof runId !== 'string') continue;
      // Load the session directly from the summary we already have (O(1) per run)
      // rather than calling reconstructDurableRunDeps which re-scans the full list.
      const session = await sessionStore.load(summary.id);
      const deps = await buildRunDepsFromSession(session);
      if (deps === null) continue;
      registerRunDeps(runId, deps);
      recovered.set(runId, summary.id);
    }

    let handles: Array<{ id: string; result(): Promise<unknown> }>;
    try {
      handles = (await runtime.durable.engine.recoverAll()) as Array<{
        id: string;
        result(): Promise<unknown>;
      }>;
    } catch (error) {
      // recoverAll itself failed — clear every pre-injected closure so nothing
      // leaks, then rethrow to the boot try/catch (which logs and continues).
      for (const runId of recovered.keys()) clearRunDeps(runId);
      throw error;
    }

    // Eagerly sweep any pre-injected run that recoverAll did NOT return a handle
    // for (e.g. a stale `running` session whose workflow already completed or was
    // pruned). Those have no monitor to clear them, so clear them now. Runs whose
    // handle WAS returned are cleared by `settleRecoveredRun`'s `finally`.
    const handledRunIds = new Set(handles.map((handle) => handle.id));
    for (const runId of recovered.keys()) {
      if (!handledRunIds.has(runId)) clearRunDeps(runId);
    }

    // Detached monitors — NOT awaited, so boot proceeds the moment recoverAll
    // has started the handles. Each monitor persists its run's terminal session
    // status and clears that run's deps in a `finally`. The `.catch` guards the
    // unawaited chain against an unhandled rejection (settleRecoveredRun swallows
    // its own errors, so this is belt-and-suspenders).
    void Promise.allSettled(
      handles.map((handle) => settleRecoveredRun(handle, recovered, sessionStore)),
    ).catch((error) => {
      console.error(`[bureau] Durable run recovery monitor error: ${serializeUnknownError(error)}`);
    });
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
      // No future recovered run should reach the (about-to-close) storage through
      // the reconstructor closure. Clear it FIRST in the finally — unconditionally,
      // before the backend teardown — so a throwing pre-teardown step above can't
      // leave a stale reconstructor (closing over the soon-to-be-disposed session
      // store) live.
      setRunDepsReconstructor(undefined);

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
