import type { Toolbox } from 'armorer';
import type { ConversationHistory, SessionInfo } from 'conversationalist';
import type { ProviderName } from 'herald';
import type { Hono } from 'hono';
import type {
  EventIteratorOptions,
  EventObservableOptions,
  ObservableLike,
  Observer,
  Subscription,
} from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';
import type { GenerateFunction, Scheduler, SessionStore, StopCondition } from 'operative';
import type { Store } from 'sentinel';
import type { KeyValueStore } from 'storage';

import type { BureauEventMap } from './events';
import type { StorageBackendConfiguration } from './storage';

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
  persistence?: KeyValueStore;
  storage?: StorageBackendConfiguration;
  memory?: CreateMemoryOptions | Memory;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  systemPrompt?: string;
}

export type BureauEventType = keyof BureauEventMap & string;

export interface Bureau {
  readonly store: Store;
  readonly memory: Memory | undefined;
  readonly scheduler: Scheduler | undefined;
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

  addEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;

  on<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventObservableOptions,
  ): ObservableLike<BureauEventMap[K]>;

  once<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
  ): void;

  subscribe<K extends keyof BureauEventMap & string>(
    type: K,
    observerOrNext?: Observer<BureauEventMap[K]> | ((value: BureauEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  toObservable(): ObservableLike<BureauEventMap[keyof BureauEventMap]>;

  events<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventIteratorOptions,
  ): AsyncIterableIterator<BureauEventMap[K]>;

  complete(): void;
  readonly completed: boolean;
  readonly signal: AbortSignal;

  dispose(): void;

  readonly sessionStore: SessionStore | undefined;
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
  | { type: 'pong' }
  | { type: 'scheduler.state'; state: unknown }
  | { type: 'scheduler.task.preempted'; taskId: string; reason: string };

// ── Health Types ────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_PORT = 5555;
export const DEFAULT_MAXIMUM_STEPS = 10;

// ── API Key Scopes ─────────────────────────────────────────────────

/** Scope definitions for route-level authorization. */
export const SCOPE = {
  RUNS_READ: 'runs:read',
  RUNS_WRITE: 'runs:write',
  CONVERSATIONS_READ: 'conversations:read',
  CONVERSATIONS_WRITE: 'conversations:write',
  CONFIG_READ: 'config:read',
  KEYS_MANAGE: 'keys:manage',
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];
