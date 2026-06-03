import type { StorageConfiguration, TextValueStore } from '@lostgradient/weft/storage';
import type { Toolbox } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
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
import type {
  AgentSession,
  CacheOptions,
  EnhancedStreamingOptions,
  GenerateFunction,
  GuardrailsOptions,
  Scheduler,
  SchedulerPriority,
  SchedulerState,
  SessionStore,
  SessionSummary,
  StopCondition,
  TokenUsage,
} from 'operative';
import type { Store } from 'sentinel';

import type { BureauEventMap } from './events';

// ── Provider Configuration ───────────────────────────────────────────

export interface ProviderConfiguration {
  provider: ProviderName;
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}

export interface ProviderRouteConfiguration {
  name: string;
  provider: ProviderConfiguration;
  budgetRatio?: number;
}

export type RedactedProviderConfiguration = Omit<ProviderConfiguration, 'apiKey'>;

export type RedactedProviderRouteConfiguration = Omit<ProviderRouteConfiguration, 'provider'> & {
  provider: RedactedProviderConfiguration;
};

export type RoutingConfiguration =
  | {
      type: 'step-based';
      first: string;
      middle: string;
      last?: string;
      middleAfterStep?: number;
    }
  | {
      type: 'complexity';
      simple: string;
      complex: string;
      frontier?: string;
      simpleMaxTools?: number;
      simpleMaxLength?: number;
    }
  | {
      type: 'cost-aware';
      cheap: string;
      expensive: string;
      budget: number;
      thresholdRatio?: number;
    };

export interface IdentityConfiguration {
  resolve: () => Promise<string>;
  warn?: (message: string) => void;
}

export interface SkillRuntimeConfiguration {
  provider: SkillProvider;
  includeTools?: boolean;
  skillPolicy?: ToolPolicy;
}

export interface ToolPolicy {
  allowList?: string[];
  denyList?: string[];
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export interface LoadedSkill {
  metadata: {
    name: string;
    description: string;
    toolPolicy?: ToolPolicy;
  };
  body: string;
}

export interface SkillProvider {
  listSkills(): Promise<SkillCatalogEntry[]>;
  loadSkill(name: string): Promise<LoadedSkill | undefined>;
  saveSkill?(name: string, skill: LoadedSkill): Promise<void>;
  deleteSkill?(name: string): Promise<void>;
  listResources(name: string): Promise<string[]>;
  loadResource(name: string, path: string): Promise<string | undefined>;
  isEnabled(name: string): Promise<boolean>;
}

export interface CacheConfiguration extends Omit<CacheOptions, 'store'> {
  enabled?: boolean;
  store?: TextValueStore;
}

export interface StreamingConfiguration extends Pick<EnhancedStreamingOptions, 'onTextDelta'> {
  enabled?: boolean;
}

export interface SchedulerConfiguration {
  enabled?: boolean;
  idleDelay?: number;
}

// ── Bureau (headless, no HTTP) ──────────────────────────────────────

export interface BureauOptions {
  generate?: GenerateFunction;
  provider?: ProviderConfiguration;
  providers?: ProviderRouteConfiguration[];
  routing?: RoutingConfiguration;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolbox?: Toolbox<any>;
  store?: Store;
  persistence?: TextValueStore;
  storage?: StorageConfiguration;
  memory?: CreateMemoryOptions | Memory;
  cache?: CacheConfiguration;
  guardrails?: GuardrailsOptions;
  identity?: IdentityConfiguration;
  skills?: SkillRuntimeConfiguration;
  streaming?: StreamingConfiguration;
  scheduler?: SchedulerConfiguration;
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
  submitSchedulerTask(request: SubmitSchedulerTaskRequest): Promise<SubmitSchedulerTaskResponse>;
  listRuns(status?: string): RunSummary[];
  getRun(id: string): RunDetail | undefined;
  abortRun(id: string): RunSummary;
  deleteRun(id: string): void;

  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<AgentSession | undefined>;
  deleteSession(id: string): Promise<void>;

  getConfiguration(): ConfigurationResponse;
  getTools(): ToolSummary[];
  subscribeLiveFrames(listener: (frame: ServerFrame) => void): () => void;

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
  readonly kv: TextValueStore | undefined;
}

// ── Gateway (HTTP layer wrapping Bureau) ────────────────────────────

export interface GatewayOptions extends BureauOptions {
  port?: number;
  hostname?: string;
  authToken?: string;
  /** Server runtime. Default: auto-detected (`'bun'` when `typeof Bun !== 'undefined'`, `'node'` otherwise). */
  runtime?: 'bun' | 'node';
}

export interface Gateway {
  readonly app: Hono;
  readonly bureau: Bureau;
  readonly store: Store;
  readonly port: number;
  start(): Promise<{ stop(): void }>;
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
  sessionId: string;
  status: string;
  steps: number;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
}

export interface RunStepDetail {
  step: number;
  content: string;
  final: boolean;
  usage?: TokenUsage;
  toolCalls: readonly {
    id?: string;
    name: string;
    arguments?: unknown;
  }[];
  results: readonly {
    toolName: string;
    result: unknown;
    error?: string;
  }[];
}

export interface RunEventRecord {
  sequence: number;
  runId: string;
  event: string;
  detail: unknown;
  timestamp: number;
}

export interface RunDetail extends RunSummary {
  events: RunEventRecord[];
  stepDetails: RunStepDetail[];
  latestSnapshot: ConversationSnapshot | undefined;
}

export interface CreateRunRequest {
  message: string;
  sessionId?: string;
  systemPrompt?: string;
  maximumSteps?: number;
}

export interface SubmitSchedulerTaskRequest {
  message: string;
  maximumSteps?: number;
  metadata?: Record<string, unknown>;
  priority?: SchedulerPriority;
  requeue?: boolean;
  systemPrompt?: string;
}

export interface SubmitSchedulerTaskResponse {
  taskId: string;
  priority: SchedulerPriority;
  status: 'queued';
}

export interface ConfigurationResponse {
  provider: RedactedProviderConfiguration | undefined;
  providers: RedactedProviderRouteConfiguration[];
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
  | {
      type: 'event';
      runId: string;
      event: string;
      detail: unknown;
      sequence: number;
      timestamp: number;
    }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'scheduler.state'; state: SchedulerState }
  | { type: 'scheduler.task.preempted'; taskId: string; reason: string; state: SchedulerState }
  | { type: 'stream:text-delta'; runId: string; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; runId: string; toolName: string; blockId: string }
  | {
      type: 'stream:tool-call-delta';
      runId: string;
      toolName: string;
      blockId: string;
      partialArgs: string;
    }
  | {
      type: 'stream:tool-call-complete';
      runId: string;
      toolName: string;
      blockId: string;
      arguments: unknown;
    }
  | { type: 'stream:complete'; runId: string; state: unknown }
  | { type: 'stream:error'; runId: string; error: string };

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
  SESSIONS_READ: 'sessions:read',
  SESSIONS_WRITE: 'sessions:write',
  CONFIG_READ: 'config:read',
  KEYS_MANAGE: 'keys:manage',
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];
