import type { ConversationHistory, SessionInfo } from 'conversationalist';
import { Conversation } from 'conversationalist';
import { createEventTarget } from 'event-emission';
import type { RunOptions, Toolbox } from 'operative';
import { createRun } from 'operative';
import type { Store } from 'sentinel';
import { createStore } from 'sentinel';

import { resolveGenerate } from './configuration';
import { serializeRunState } from './serialization';
import type {
  Bureau,
  BureauEvents,
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

export function createBureau(options: BureauOptions = {}): Bureau {
  const ownsStore = !options.store;
  const store: Store = options.store ?? createStore();
  const emitter = createEventTarget<BureauEvents>();
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;

  // Forward all store events to the bureau emitter
  const storeSubscription = store.toObservable().subscribe((event) => {
    const type = event.type as keyof BureauEvents;
    emitter.emit(type, event.detail as BureauEvents[typeof type]);
  });

  const generate =
    options.generate ?? (options.provider ? resolveGenerate(options.provider) : undefined);
  const toolbox = options.toolbox as Toolbox | undefined;
  const persistence = options.persistence;
  const stopWhen = options.stopWhen;
  const systemPrompt = options.systemPrompt;
  const provider = options.provider;

  const emptyToolbox = {
    tools: () => [],
    execute: () => Promise.resolve([]),
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

    let conversation: InstanceType<typeof Conversation>;
    let isExistingConversation = false;

    if (request.conversationId && persistence) {
      const history = await persistence.load(request.conversationId);
      if (history) {
        conversation = new Conversation(history);
        isExistingConversation = true;
      } else {
        conversation = new Conversation();
      }
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

  function requirePersistence() {
    if (!persistence) {
      throw new BureauError('No persistence adapter configured', 'NOT_IMPLEMENTED');
    }
    return persistence;
  }

  function listConversations(): Promise<SessionInfo[]> {
    const adapter = requirePersistence();
    return adapter.list();
  }

  function getConversation(id: string): Promise<ConversationHistory | undefined> {
    const adapter = requirePersistence();
    return adapter.load(id);
  }

  function deleteConversation(id: string): Promise<void> {
    const adapter = requirePersistence();
    return adapter.delete(id);
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
    emitter.emit('bureau.disposed', {} as Record<string, never>);
    storeSubscription.unsubscribe();
    emitter.complete();
    if (ownsStore) {
      store.dispose();
    }
  }

  return {
    store,
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
    addEventListener: emitter.addEventListener,
    on: emitter.on,
    once: emitter.once,
    subscribe: emitter.subscribe,
    toObservable: emitter.toObservable,
    events: emitter.events,
    complete: emitter.complete,
    get completed() {
      return emitter.completed;
    },
    dispose,
  };
}
