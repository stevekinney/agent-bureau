import type {
  HistoryPolicy,
  ListFilter,
  ListOptions,
  PaginatedResult,
  WorkflowLogRecord,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';
import type { ObservabilityOptions } from '@lostgradient/weft/observability';
import type { StorageConfiguration, TextValueStore } from '@lostgradient/weft/storage';
import type { Toolbox } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import type { ToolPolicy } from 'interoperability';
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
import type { CreateRunEngineOptions } from 'operative/durable';
import type { ProviderName } from 'operative/providers';
import type { Store } from 'operative/store';

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
  /**
   * The skill provider backing the catalog. When omitted and the bureau has
   * a `.persistence()` / `storage` backend configured, the bureau automatically
   * constructs a storage-backed provider via `createStorageSkillProvider(kv)`.
   * Supply an explicit provider to use a static catalog or a custom backend.
   */
  provider?: SkillProvider;
  includeTools?: boolean;
  skillPolicy?: ToolPolicy;
}

export type { ToolPolicy };

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

// ── Persistence Options ─────────────────────────────────────────────

/**
 * Unified persistence options for {@link BureauOptions.persistence}.
 *
 * Pass `.persistence({ store, history, observability, onLog })` to co-locate the
 * storage backend with its operational knobs. The bureau builds one Weft engine
 * over `store` — the engine handles durable run checkpointing; a `TextValueStore`
 * view of the same backend is used for sessions, cache, and memory.
 *
 * Only `store` is required. `history` and `observability` are the two operational
 * knobs exposed in v1; additional guardrails can be specified but are deferred.
 *
 * @see {@link BureauOptions.persistence}
 */
export interface PersistenceOptions {
  /**
   * The Weft storage backend config. The bureau resolves this to a raw `Storage`
   * and builds both the durable engine AND the `TextValueStore` KV layer from it.
   * One config → one backend → one engine (the Weft invariant: one engine per
   * durable store).
   */
  store: StorageConfiguration;

  /**
   * History circuit-breaker for the durable engine. An agent run checkpoints its
   * full transcript per step; `history.maxEvents` caps how long the event-log may
   * grow before the run is force-terminated. Omit to disable.
   */
  history?: HistoryPolicy;

  /**
   * Opt into OpenTelemetry spans + metrics for durable runs. `true` enables the
   * default interceptor; pass an {@link ObservabilityOptions} object (minus
   * `eventTarget`, which the engine supplies) to customize.
   * `@opentelemetry/api` is an optional peer — spans are no-ops without it, so
   * enabling this is safe before any telemetry backend exists.
   */
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>;

  /**
   * Host sink for `ctx.log` records emitted by durable workflows. Receives every
   * replay-safe log record from inline execution. A throwing sink falls back to
   * the host console without failing the workflow.
   */
  onLog?: (record: WorkflowLogRecord) => void;
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
  /**
   * Persistence for this bureau. Accepts three forms:
   *
   * - **`PersistenceOptions`** — `{ store: StorageConfiguration, history?, observability?, onLog? }`:
   *   the full options-object form. The bureau resolves `store` to a Weft `Storage`
   *   backend and builds both the durable engine AND the KV layer from it. This is
   *   the canonical form for durable bureaus: one config → one engine.
   *
   * - **`StorageConfiguration`** — shorthand for `{ store: config }` with no extra
   *   knobs. Durable execution is on by default for persistent backends (`sqlite`,
   *   `lmdb`) and off by default for `memory` (which loses checkpoints with the
   *   process). Use `storage` field or `durableExecution` override if needed.
   *
   * - **`TextValueStore`** — KV-only (no durable engine). Used for session/cache
   *   persistence without durability. Cannot be combined with `durableExecution:
   *   true` (a durable engine needs a raw `Storage` to checkpoint against).
   *
   * When omitted, runs are ephemeral (in-memory loop, no sessions persisted).
   */
  persistence?: PersistenceOptions | StorageConfiguration | TextValueStore;
  storage?: StorageConfiguration;
  /**
   * Override for Weft-backed durable execution. Durable execution is **on by
   * default whenever a persistent `storage` backend (`sqlite`/`lmdb`) is
   * configured** — every `createRun()` is then checkpointed on the same backend
   * and resumes from its last completed step after a crash, with the standard
   * `run()`/`createRun()` event surface unchanged.
   *
   * The default follows persistence because that is the only place resume is
   * real: a `memory` backend loses its checkpoints with the process, so it stays
   * OFF by default. Set this explicitly to override the default either way —
   * `true` forces the engine on (incl. for `memory`, so durable behavior is
   * testable locally); `false` forces it off even for a persistent backend.
   * Has no effect without any `storage` (a durable engine needs a backend).
   *
   * `durableExecution: true` is rejected when combined with a custom
   * `persistence` value: `persistence` shadows `storage`, so the engine and the
   * session store would live on different backends and a recovered run could
   * never be found. Provide `storage` WITHOUT `persistence` for durable runs.
   *
   * Known limitation (seam #5b): a run RESUMED after a process restart (via
   * boot recovery) persists its terminal SESSION status — observable through
   * {@link Bureau.getSession} — but is not re-registered with the run store, so
   * {@link Bureau.getRun} and live event subscribers do not see that recovered
   * run individually. Use `getSession` to confirm a recovered run's outcome.
   */
  durableExecution?: boolean;
  memory?: CreateMemoryOptions | Memory;
  cache?: CacheConfiguration;
  guardrails?: GuardrailsOptions;
  identity?: IdentityConfiguration;
  skills?: SkillRuntimeConfiguration;
  streaming?: StreamingConfiguration;
  scheduler?: SchedulerConfiguration;
  stopWhen?: StopCondition | StopCondition[];
  sessionPersistenceRetryDelayMilliseconds?: number;
  sessionPersistenceSleep?: (milliseconds: number) => Promise<void>;
  maximumSteps?: number;
  systemPrompt?: string;
  /**
   * Opt into OpenTelemetry spans + metrics for durable runs. `true` enables the
   * default interceptor; pass an {@link ObservabilityOptions} (minus `eventTarget`,
   * which the engine supplies) to customize. Has effect only when a durable engine
   * is composed. `@opentelemetry/api` is an optional peer — without it spans are
   * no-ops, so enabling this is safe before any telemetry backend exists.
   */
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>;
  /**
   * Host sink for `ctx.log` records emitted by durable workflows (Weft 0.4.0
   * structured logging). Has effect only when a durable engine is composed.
   */
  onLog?: (record: WorkflowLogRecord) => void;
  /**
   * History/checkpoint guardrails for durable runs. `history.maxEvents` is a
   * circuit breaker (a breach terminates the run as an error, classified
   * distinctly from a deadline timeout); `checkpointSizeWarningThreshold` arms an
   * early-warning event observed via {@link onCheckpointSizeWarning}. Has effect
   * only when a durable engine is composed.
   */
  durableGuardrails?: DurableGuardrailsConfiguration;
}

/**
 * Durable history/checkpoint guardrail configuration surfaced on
 * {@link BureauOptions.durableGuardrails}. A direct `Pick` of the matching
 * {@link CreateRunEngineOptions} fields — no duplicated field declarations, so the
 * single source of truth stays on the engine options and the composition spreads
 * this straight through.
 */
export type DurableGuardrailsConfiguration = Pick<
  CreateRunEngineOptions,
  | 'history'
  | 'checkpointSizeWarningThreshold'
  | 'checkpointHistory'
  | 'payloadSize'
  | 'onCheckpointSizeWarning'
>;

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

  /**
   * Read the durable engine's view of a run: its full {@link WorkflowState}
   * (status, step cursor, failure category, termination reason, timestamps).
   * Backed by `engine.get(runId)`. Returns `null` when the run is unknown to the
   * engine and `undefined` when no durable engine is composed. This is the only
   * way to see a run's durable status mid-flight — session metadata is written
   * only at terminal transitions, and a recovered run is otherwise opaque.
   */
  getDurableRun(runId: string): Promise<WorkflowState | null | undefined>;

  /**
   * List durable runs from the engine, optionally filtered (status, type, tags).
   * Backed by `engine.list(filter, options)`. Returns `undefined` when no durable
   * engine is composed. Note the engine internally types the filter as a
   * `TypedListFilter`; the plain {@link ListFilter} accepted here is structurally
   * compatible as long as `attributes` is omitted. A scan-cap breach from the
   * engine surfaces as a thrown weft fault (catch generically — the cap error is
   * not on the public barrel).
   */
  listDurableRuns(
    filter?: ListFilter,
    options?: ListOptions,
  ): Promise<PaginatedResult<WorkflowSummary> | undefined>;

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

// ── API Request / Response Types ─────────────────────────────────────

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

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_MAXIMUM_STEPS = 10;
