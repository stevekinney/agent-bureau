import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { type ActiveRun, createAgentSession, createRun, type JSONValue } from 'operative';
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
  const runtime = await createRuntimeComposition(options);
  const runSessionIdentifiers = new WeakMap<ActiveRun, string>();
  const liveFrameListeners = new Set<(frame: ServerFrame) => void>();

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
            await new Promise((resolve) =>
              setTimeout(resolve, SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS),
            );
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
    if (runtime.scheduler) {
      void runtime.scheduler.stop().catch(() => {});
    }

    if (runtime.memory) {
      void runtime.memory.close().catch(() => {});
    }

    emitter.dispatch(new BureauDisposedEvent());
    storeSubscription.unsubscribe();
    for (const disposeListener of schedulerCleanup) {
      disposeListener();
    }
    emitter.complete();

    if (ownsStore) {
      store.dispose();
    }
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
