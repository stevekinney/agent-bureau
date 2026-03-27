import type { ConversationHistory, SessionInfo } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';
import { createMemory } from 'memory';
import type { RunOptions, Scheduler, Toolbox } from 'operative';
import { createRun, createScheduler } from 'operative';
import type {
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  Store,
  StoreActionEvent,
} from 'sentinel';
import { createStore } from 'sentinel';

import { resolveGenerate } from './configuration';
import {
  ActionEvent,
  BureauDisposedEvent,
  type BureauEventMap,
  RunRegisteredEvent,
  RunRemovedEvent,
} from './events';
import { serializeRunState } from './serialization';
import { resolveStorageBackend } from './storage';
import type {
  Bureau,
  BureauOptions,
  ConfigurationResponse,
  CreateRunRequest,
  ProviderConfiguration,
  RunSummary,
  ToolSummary,
} from './types';
import { DEFAULT_MAXIMUM_STEPS } from './types';

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

function isMemoryInstance(value: CreateMemoryOptions | Memory): value is Memory {
  return typeof (value as Memory).remember === 'function';
}

export async function createBureau(options: BureauOptions = {}): Promise<Bureau> {
  const ownsStore = !options.store;
  const store: Store = options.store ?? createStore();
  const emitter = new CompletableEventTarget<BureauEventMap>();
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;

  // Forward all store events to the bureau emitter
  const storeSubscription = store.toObservable().subscribe((event) => {
    switch (event.type) {
      case 'action':
        emitter.dispatch(new ActionEvent((event as StoreActionEvent).action));
        break;
      case 'run.registered':
        emitter.dispatch(new RunRegisteredEvent((event as StoreRunRegisteredEvent).runId));
        break;
      case 'run.removed':
        emitter.dispatch(new RunRemovedEvent((event as StoreRunRemovedEvent).runId));
        break;
    }
  });

  // ── Storage Backend ──────────────────────────────────────────────
  // Only the KV store is used here for conversation persistence; the
  // vector adapter is wired separately when memory is configured.
  const resolvedStorage = options.storage
    ? await resolveStorageBackend(options.storage)
    : undefined;
  const resolvedKv = resolvedStorage?.kv;

  // ── Memory ───────────────────────────────────────────────────────
  let memory: Memory | undefined;

  if (options.memory) {
    memory = isMemoryInstance(options.memory) ? options.memory : createMemory(options.memory);
  }

  if (memory) {
    await memory.init();
  }

  const generate =
    options.generate ?? (options.provider ? resolveGenerate(options.provider) : undefined);
  const toolbox = options.toolbox as Toolbox | undefined;
  const kv = options.persistence ?? resolvedKv;
  const stopWhen = options.stopWhen;
  const systemPrompt = options.systemPrompt;
  const provider = options.provider;

  // ── Scheduler ──────────────────────────────────────────────────
  let scheduler: Scheduler | undefined;

  if (generate && toolbox) {
    scheduler = createScheduler({
      generate,
      toolbox,
      idleDelay: 1000,
    });
    scheduler.start();
  }

  const emptyToolbox = {
    tools: () => [],
    execute: (toolCalls: unknown[]) => {
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        throw new BureauError(
          'No toolbox configured but tool calls were received',
          'NOT_CONFIGURED',
        );
      }
      return Promise.resolve([]);
    },
    toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
  } as unknown as Toolbox;

  // ── Runs ────────────────────────────────────────────────────────

  async function createRunFromRequest(request: CreateRunRequest): Promise<RunSummary> {
    if (!generate) {
      throw new BureauError('No generate function configured', 'NOT_CONFIGURED');
    }

    if (!request.message || typeof request.message !== 'string') {
      throw new BureauError('Request must include a "message" string', 'BAD_REQUEST');
    }

    if (request.conversationId !== undefined && typeof request.conversationId !== 'string') {
      throw new BureauError('"conversationId" must be a string', 'BAD_REQUEST');
    }

    if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') {
      throw new BureauError('"systemPrompt" must be a string', 'BAD_REQUEST');
    }

    if (request.maximumSteps !== undefined) {
      if (
        typeof request.maximumSteps !== 'number' ||
        !Number.isInteger(request.maximumSteps) ||
        request.maximumSteps <= 0
      ) {
        throw new BureauError('"maximumSteps" must be a positive integer', 'BAD_REQUEST');
      }
    }

    let conversation: InstanceType<typeof Conversation>;
    let isExistingConversation = false;

    if (request.conversationId && kv) {
      const raw = await kv.get(`session:${request.conversationId}`);
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'ids' in parsed) {
            conversation = new Conversation(parsed as ConversationHistory, { persistence: kv });
            isExistingConversation = true;
          } else {
            conversation = new Conversation(createConversationHistory(), { persistence: kv });
          }
        } catch {
          conversation = new Conversation(createConversationHistory(), { persistence: kv });
        }
      } else {
        conversation = new Conversation(createConversationHistory(), { persistence: kv });
      }
    } else if (kv) {
      conversation = new Conversation(createConversationHistory(), { persistence: kv });
    } else {
      conversation = new Conversation();
    }

    if (!isExistingConversation) {
      const prompt = request.systemPrompt ?? systemPrompt;
      if (prompt) {
        conversation.appendSystemMessage(prompt);
      }
    }
    conversation.appendUserMessage(request.message);

    const runOptions: RunOptions = {
      generate,
      toolbox: toolbox ?? emptyToolbox,
      conversation,
      maximumSteps: request.maximumSteps ?? maximumSteps,
    };

    if (stopWhen) {
      runOptions.stopWhen = stopWhen;
    }

    const activeRun = createRun(runOptions);
    const runId = store.register(activeRun);

    return {
      id: runId,
      status: 'running',
      steps: 0,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      actionCount: 0,
    };
  }

  function listRuns(status?: string): RunSummary[] {
    const state = store.getState();
    const summaries: RunSummary[] = [];
    for (const [, runState] of state.runs) {
      if (status && runState.status !== status) continue;
      summaries.push(serializeRunState(runState));
    }
    return summaries;
  }

  function getRun(id: string): RunSummary | undefined {
    const runState = store.getRun(id);
    if (!runState) return undefined;
    return serializeRunState(runState);
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
    return { ...serializeRunState(runState), status: 'aborted' };
  }

  function deleteRun(id: string): void {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }
    if (runState.status === 'running') {
      throw new BureauError('Cannot delete a running run', 'CONFLICT');
    }
    store.removeRun(id);
  }

  // ── Conversations ───────────────────────────────────────────────

  function requireKv() {
    if (!kv) {
      throw new BureauError('No persistence adapter configured', 'NOT_IMPLEMENTED');
    }
    return kv;
  }

  async function listConversations(): Promise<SessionInfo[]> {
    const store = requireKv();
    const keys = await store.list('session-info:');
    const results: SessionInfo[] = [];
    for (const key of keys) {
      const raw = await store.get(key);
      if (!raw) continue;
      try {
        results.push(JSON.parse(raw) as SessionInfo);
      } catch {
        // Skip malformed entries
      }
    }
    return results;
  }

  async function getConversation(id: string): Promise<ConversationHistory | undefined> {
    const store = requireKv();
    const raw = await store.get(`session:${id}`);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'ids' in parsed) {
        return parsed as ConversationHistory;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    const store = requireKv();
    await Promise.all([store.delete(`session:${id}`), store.delete(`session-info:${id}`)]);
  }

  // ── Configuration ───────────────────────────────────────────────

  function getToolSummaries(): ToolSummary[] {
    if (!toolbox) return [];
    return toolbox.tools().map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
    }));
  }

  function redactProvider(): Omit<ProviderConfiguration, 'apiKey'> | undefined {
    if (!provider) return undefined;
    const { apiKey: _apiKey, ...safeProvider } = provider;
    return safeProvider;
  }

  function getConfiguration(): ConfigurationResponse {
    return {
      provider: redactProvider(),
      maximumSteps,
      systemPrompt,
      tools: getToolSummaries(),
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  function dispose(): void {
    if (scheduler) {
      void scheduler.stop().catch(() => {});
    }
    if (memory) {
      void memory.close().catch(() => {});
    }
    emitter.dispatch(new BureauDisposedEvent());
    storeSubscription.unsubscribe();
    emitter.complete();
    if (ownsStore) {
      store.dispose();
    }
  }

  return {
    store,
    memory,
    scheduler,
    get ready() {
      return generate !== undefined;
    },
    createRun: createRunFromRequest,
    listRuns,
    getRun,
    abortRun,
    deleteRun,
    listConversations,
    getConversation,
    deleteConversation,
    getConfiguration,
    getTools: getToolSummaries,
    addEventListener: (type, listener, options) =>
      emitter.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) =>
      emitter.removeEventListener(type, listener, options),
    on: (type, options) => emitter.on(type, options),
    once: (type, listener) => emitter.once(type, listener),
    subscribe: (type, observerOrNext, error, complete) =>
      emitter.subscribe(type, observerOrNext, error, complete),
    toObservable: () => emitter.toObservable(),
    events: (type, options) => emitter.events(type, options),
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
