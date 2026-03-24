import type { Toolbox } from 'armorer';
import type {
  ConversationHistory,
  SessionInfo,
  SessionPersistenceAdapter,
} from 'conversationalist';
import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
} from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import type { ProviderName } from 'herald';
import type { Hono } from 'hono';
import type { GenerateFunction, StopCondition } from 'operative';
import type { Action, Store } from 'sentinel';

// ── Provider Configuration ───────────────────────────────────────────

export interface ProviderConfiguration {
  provider: ProviderName;
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}

// ── Bureau (headless, no HTTP) ──────────────────────────────────────

export interface BureauOptions {
  generate?: GenerateFunction;
  provider?: ProviderConfiguration;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolbox?: Toolbox<any>;
  store?: Store;
  persistence?: SessionPersistenceAdapter;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  systemPrompt?: string;
}

export interface BureauEvents {
  action: Action;
  'run.registered': { runId: string };
  'run.removed': { runId: string };
  'bureau.disposed': Record<string, never>;
}

export type BureauEventType = keyof BureauEvents;

export interface Bureau {
  readonly store: Store;
  readonly ready: boolean;

  createRun(request: CreateRunRequest): Promise<RunSummary>;
  listRuns(status?: string): RunSummary[];
  getRun(id: string): RunSummary | undefined;
  abortRun(id: string): RunSummary;
  deleteRun(id: string): void;

  listConversations(): Promise<SessionInfo[]>;
  getConversation(id: string): Promise<ConversationHistory | undefined>;
  deleteConversation(id: string): Promise<void>;

  getConfiguration(): ConfigurationResponse;
  getTools(): ToolSummary[];

  addEventListener<K extends BureauEventType>(
    type: K,
    listener: (event: EmissionEvent<BureauEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ): () => void;

  on<K extends BureauEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ): ObservableLike<EmissionEvent<BureauEvents[K], K>>;

  once<K extends BureauEventType>(
    type: K,
    listener: (event: EmissionEvent<BureauEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ): () => void;

  subscribe<K extends BureauEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<BureauEvents[K], K>>
      | ((value: EmissionEvent<BureauEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  toObservable(): ObservableLike<EmissionEvent<BureauEvents[keyof BureauEvents]>>;

  events<K extends BureauEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ): AsyncIterableIterator<EmissionEvent<BureauEvents[K], K>>;

  complete(): void;
  readonly completed: boolean;

  dispose(): void;
}

// ── Gateway (HTTP layer wrapping Bureau) ────────────────────────────

export interface GatewayOptions extends BureauOptions {
  port?: number;
  hostname?: string;
  authToken?: string;
}

export interface Gateway {
  readonly app: Hono;
  readonly bureau: Bureau;
  readonly store: Store;
  readonly port: number;
  start(): { stop(): void };
}

// ── API Response Types ──────────────────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface RunSummary {
  id: string;
  status: string;
  steps: number;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
}

export interface CreateRunRequest {
  message: string;
  conversationId?: string;
  systemPrompt?: string;
  maximumSteps?: number;
}

export interface ConfigurationResponse {
  provider: Omit<ProviderConfiguration, 'apiKey'> | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
  tools: ToolSummary[];
}

export interface ToolSummary {
  name: string;
  description: string;
}

// ── WebSocket Frame Types ───────────────────────────────────────────

export type ClientFrame =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'ping' };

export type ServerFrame =
  | { type: 'event'; runId: string; event: string; detail: unknown; timestamp: number }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

// ── Health Types ────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_PORT = 5555;
export const DEFAULT_MAXIMUM_STEPS = 10;
