import type {
  HistoryPolicy,
  ListFilter,
  ListOptions,
  PaginatedResult,
  ScheduleFilter,
  ScheduleSummary,
  WorkflowLogRecord,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';
import type { ObservabilityOptions } from '@lostgradient/weft/observability';
import type { StorageConfiguration, TextValueStore } from '@lostgradient/weft/storage';
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import type { PendingToolApproval, SignedPendingToolApproval, Toolbox } from 'armorer';
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
  FlowControlPolicy,
  GenerateFunction,
  GuardrailsOptions,
  RunFrame,
  RunReport,
  Scheduler,
  SchedulerPriority,
  SchedulerState,
  SessionStore,
  SessionSummary,
  StopCondition,
  TokenUsage,
} from 'operative';
import type { CreateRunEngineOptions } from 'operative/durable';
import type { Store } from 'operative/store';

import type { AuditTrail } from './audit-trail';
import type { BureauEventMap } from './events';
import type { OnlineEvalSampler, OnlineEvalSamplerOptions } from './online-evals';
import type { WebhookNotifier, WebhookNotifierOptions } from './webhook-notifier';

// ── Provider Configuration ───────────────────────────────────────────

/**
 * The subset of operative's `ProviderName` union that `createRuntimeComposition`
 * can resolve to a generative (text/tool-call) backend. `voyage` and `ollama`
 * exist in `ProviderName` but are embedding-only — no generate factory exists for
 * them, so accepting them here would produce a runtime "Unknown provider" error
 * that TypeScript could have caught.
 */
export type GenerateProviderName = 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfiguration {
  provider: GenerateProviderName;
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

export type { FlowControlPolicy, ToolPolicy };

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
 * over `store` — the engine handles durable run checkpointing; a `ConditionalTextValueStore`
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
   * and builds both the durable engine AND the `ConditionalTextValueStore` KV layer from it.
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
   * - **`ConditionalTextValueStore`** — KV-only (no durable engine). Used for session/cache
   *   persistence without durability. Cannot be combined with `durableExecution:
   *   true` (a durable engine needs a raw `Storage` to checkpoint against).
   *
   * When omitted, runs are ephemeral (in-memory loop, no sessions persisted).
   */
  persistence?: PersistenceOptions | StorageConfiguration | ConditionalTextValueStore;
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
  /**
   * AB-40 — guardrail tripwires. When omitted (the default), bureau wires an
   * enabled-by-default preset: a prompt-injection input detector + an output
   * PII validator, both running in `mode: 'tripwire'` (a trip hard-halts the
   * run with `finishReason: 'tripwire'` rather than substituting a response).
   * Pass a `GuardrailsOptions` to override the preset entirely (input/output
   * detectors, taint, `mode`), or `false` to opt out of guardrails altogether.
   */
  guardrails?: GuardrailsOptions | false;
  identity?: IdentityConfiguration;
  skills?: SkillRuntimeConfiguration;
  streaming?: StreamingConfiguration;
  scheduler?: SchedulerConfiguration;
  /**
   * AB-13 — declarative flow control gating run ADMISSION, composed over
   * operative's `createFlowController`: a per-key concurrency cap, a rate
   * limit keyed by an arbitrary function of the trigger, and singleton
   * dedupe of concurrent identical triggers. Applies uniformly to both
   * API-triggered runs (`createRun`) and scheduler-originated ones
   * (`submitSchedulerTask`, durable schedule fires) — the same policy
   * instance tracks state across both surfaces. `concurrency`/`rateLimit`
   * default their grouping key to the run's `agentName`; `singleton`
   * requires an explicit key (there is no sane default identity for "this
   * is a duplicate of that"). A rejected admission throws
   * `BureauError` with code `RATE_LIMITED`. Omit to disable — the default.
   */
  flowControl?: FlowControlPolicy;
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
  /**
   * Caller-supplied version identifier for the currently-deployed agent/workflow
   * code (e.g. the app's `package.json` version or a deploy SHA) — AB-10,
   * workflow versioning for in-flight durable runs. Has effect only when a
   * durable engine is composed.
   *
   * Stamped into every new durable run's checkpoint at creation
   * (`CreateRunEngineOptions.runWorkflowVersion` /
   * `createRunWorkflow`'s `version` option), and compared against each
   * recovered run's stamped version on boot. A mismatch does not block or
   * alter recovery — it is a PIN-AND-WARN signal only, surfaced via
   * `classifyRecoveredRun`'s `'reattach-version-mismatch'` verdict (instead of
   * plain `'reattach'`) and logged at boot. See
   * `documentation/workflow-versioning.md` for the deploy runbook: what happens
   * to in-flight runs when this value changes across a deploy.
   *
   * Omit to disable version tracking entirely — every run's stamped version is
   * then `undefined` and no mismatch is ever reported.
   */
  workflowVersion?: string;
  /**
   * Notification delivery for pending approvals (AB-21). Configured targets
   * receive a webhook POST on `elicitation.requested`, a newly-appeared
   * `approval-pending` review, and a newly-appeared `human-wait.parked`
   * review, each carrying a deep link back into the AB-20 review queue (or
   * the run detail page for elicitation, which has no review-queue item).
   * Omit or pass `{ targets: [] }` to disable — the default.
   */
  webhooks?: WebhookNotifierOptions;
  /**
   * Online evaluations (AB-53) — samples a fraction of completed live runs
   * through configured judges/matchers, records every sampled score to the
   * durable audit trail, and fires a webhook (via `options.webhooks`, AB-21's
   * durable delivery infra) when a judge's score breaches its configured
   * alert threshold. Omit, pass no judges, or pass `sampleRate: 0` to
   * disable — the default.
   */
  onlineEvals?: OnlineEvalSamplerOptions;
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

// ── Review queue (AB-20) ─────────────────────────────────────────────

/**
 * A tool call parked by armorer's `needs_approval` policy decision. `approval`
 * is the exact {@link PendingToolApproval} (signed with `approvalToken` when
 * the bureau's toolbox was constructed with `approvalSecret`) that
 * `resolveReview` passes straight to `Toolbox.resumeApproval` on approve.
 */
export interface PendingToolApprovalReview {
  kind: 'tool-approval';
  /** Stable id for this review, e.g. `approval:<runId>:<callId>`. */
  id: string;
  runId: string;
  sessionId: string;
  agentName: string | undefined;
  approval: PendingToolApproval | SignedPendingToolApproval;
  /** Epoch-ms timestamp the tool call requested approval. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
}

/**
 * A durable run parked on `ctx.waitForSignal` by the `requestHumanInput` tool
 * (operative's F3 HITL primitive). `signalName` is the exact name
 * `resolveReview` passes to `Bureau.signalSession` on approve.
 */
export interface PendingHumanWaitReview {
  kind: 'human-wait';
  /** Stable id for this review, e.g. `human-wait:<runId>:<signalName>`. */
  id: string;
  runId: string;
  sessionId: string;
  agentName: string | undefined;
  signalName: string;
  prompt: string | undefined;
  /** Epoch-ms timestamp the run parked. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
}

/** A single item in the gateway's review queue (AB-20). */
export type PendingReview = PendingToolApprovalReview | PendingHumanWaitReview;

export interface ResolveReviewInput {
  /** The {@link PendingReview.id} to resolve. */
  id: string;
  decision: 'approve' | 'deny';
  /**
   * The authenticated principal making the decision (e.g. `api-key:<id>` or
   * `static-token`). Recorded in the audit trail for attribution — required,
   * not optional, so every resolution is attributable.
   */
  principal: string;
  /**
   * `tool-approval` approve only: override the tool call's arguments instead
   * of resuming with the originally-proposed ones. Ignored for `deny` and for
   * `human-wait` reviews.
   */
  arguments?: unknown;
  /** `human-wait` approve only: the payload delivered with the signal. */
  payload?: unknown;
  /** Optional human-readable note, recorded in the audit trail either way. */
  reason?: string;
}

export interface ResolveReviewResult {
  id: string;
  kind: PendingReview['kind'];
  decision: 'approve' | 'deny';
  /** The tool's `ToolExecutionResult` when a `tool-approval` was approved. */
  result?: unknown;
}

export interface Bureau {
  readonly store: Store;
  readonly memory: Memory | undefined;
  readonly scheduler: Scheduler | undefined;
  readonly ready: boolean;

  createRun(request: CreateRunRequest): Promise<RunSummary>;
  submitSchedulerTask(request: SubmitSchedulerTaskRequest): Promise<SubmitSchedulerTaskResponse>;
  listRuns(status?: string): RunSummary[];
  getRun(id: string): RunDetail | undefined;

  /**
   * Synchronously returns the versioned, JSON-serializable {@link RunReport}
   * (AB-96) for a run — a plain in-memory read, no I/O, no promise.
   *
   * For a terminal run (`completed`/`error`/`aborted`) this is the cached
   * report built at the moment the run's lifecycle event fired. For a
   * still-`running` run this synchronously builds a **partial** report from
   * the live `RunState` (accumulated usage, transcript through the last
   * checkpointed step) — the graceful-shutdown path: call this right after
   * `abortRun(id)` (or from a `SIGTERM` handler, before process exit) to
   * capture what the run had accomplished, without waiting for the abort to
   * fully settle. Returns `undefined` when `id` is unknown.
   */
  getRunReport(id: string): RunReport | undefined;
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

  /**
   * Deliver a fire-and-forget signal to a session's current in-flight durable run.
   * Maps to `engine.signal(runId, name, payload)`. Requires a durable engine and a
   * session store. Throws `BureauError('NOT_CONFIGURED')` when no durable engine is
   * composed; throws `BureauError('NOT_FOUND')` when the session has no current run.
   */
  signalSession(sessionId: string, name: string, payload?: unknown): Promise<void>;

  /**
   * Send a validated, request/response update to a session's current in-flight run.
   * Maps to `engine.update(runId, name, payload)`. Returns the update result.
   * Throws `BureauError('NOT_CONFIGURED')` when no durable engine is composed.
   */
  updateSession(sessionId: string, name: string, payload?: unknown): Promise<unknown>;

  /**
   * Query live state from a session's current in-flight run without mutating it.
   * Maps to `engine.query(runId, name, input)`. Returns the query result.
   * Throws `BureauError('NOT_CONFIGURED')` when no durable engine is composed.
   */
  querySession(sessionId: string, name: string, input?: unknown): Promise<unknown>;

  /**
   * List every parked run awaiting human review (AB-20): armorer's
   * `needs_approval` tool-approval flow AND durable `requestHumanInput`
   * (`ctx.waitForSignal`) waits, across all live runs. Newest requests last
   * are NOT guaranteed — order is run-registration order, not age order.
   * Excludes items already resolved via `resolveReview` (approved or denied),
   * even if the underlying run has not produced further activity.
   */
  listPendingReviews(): PendingReview[];

  /**
   * Approve or deny a pending review. Approve resumes the run: a
   * `tool-approval` calls `Toolbox.resumeApproval` on the bureau's toolbox and
   * returns its `ToolExecutionResult`; a `human-wait` calls `signalSession`
   * with the parked signal name. Deny records the decision without resuming
   * anything — there is no built-in "reject and continue" verb for either
   * primitive, so a denied tool call is simply never resumed and a denied
   * human-wait run stays parked. Every resolution — approve or deny — is
   * recorded in the audit trail attributed to `input.principal`.
   *
   * Throws `BureauError('NOT_FOUND')` when `input.id` does not match a
   * currently pending review (including an already-resolved one).
   */
  resolveReview(input: ResolveReviewInput): Promise<ResolveReviewResult>;

  /**
   * Register a durable recurring schedule via `engine.schedule(...)`.
   * Returns `null` when the schedule was created but could not be immediately
   * retrieved. Returns `undefined` when no durable engine is composed.
   */
  createSchedule(
    definition: DurableScheduleDefinition,
  ): Promise<ScheduleSummary | null | undefined>;

  /**
   * Retrieve a durable schedule by id. Returns `null` when the schedule does not
   * exist, `undefined` when no durable engine is composed.
   */
  getSchedule(scheduleId: string): Promise<ScheduleSummary | null | undefined>;

  /**
   * List durable schedules, optionally filtered. Returns `undefined` when no
   * durable engine is composed.
   */
  listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary> | undefined>;

  /**
   * Pause a durable schedule. Returns `true` on success, `undefined` when no
   * durable engine is composed.
   */
  pauseSchedule(scheduleId: string): Promise<true | undefined>;

  /**
   * Resume a paused durable schedule. Returns `true` on success, `undefined` when no
   * durable engine is composed.
   */
  resumeSchedule(scheduleId: string): Promise<true | undefined>;

  /**
   * Cancel and permanently delete a durable schedule. Returns `true` on success,
   * `undefined` when no durable engine is composed.
   */
  cancelSchedule(scheduleId: string): Promise<true | undefined>;

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
  readonly kv: ConditionalTextValueStore | undefined;

  /**
   * The durable audit trail (Layer B glass-box).
   *
   * Present when the bureau has a KV store configured (`.persistence()` or
   * `storage`). `undefined` when the bureau is ephemeral (no persistence).
   *
   * The audit trail sinks `tool.*`, `run.*`, and `step.completed` events into
   * the KV store as an append-only log. Use `auditTrail.query()` to read them
   * back with optional `since`, `runId`, and `type` filters.
   *
   * Layer A (live) = `store.getState()` + `memory.list()` + `getSession()`.
   * Layer B (durable) = `auditTrail.query()`.
   */
  readonly auditTrail: AuditTrail | undefined;

  /**
   * The webhook notifier (AB-21). Present whenever `options.webhooks.targets`
   * is non-empty; `undefined` when no webhooks are configured (the default).
   * Use `webhookNotifier.listDeliveries()` to inspect durable delivery state.
   */
  readonly webhookNotifier: WebhookNotifier | undefined;

  /**
   * The online eval sampler (AB-53). Present whenever `options.onlineEvals`
   * configures at least one judge with a positive `sampleRate`; `undefined`
   * when online evals are disabled (the default). Use
   * `onlineEvalSampler.sampledCount()`/`observedCount()` to inspect sampling
   * state and `onlineEvalSampler.flush()` to await in-flight judge
   * evaluations deterministically.
   */
  readonly onlineEvalSampler: OnlineEvalSampler | undefined;
}

// ── API Request / Response Types ─────────────────────────────────────

export interface RunSummary {
  id: string;
  sessionId: string;
  status: string;
  steps: number;
  /**
   * Token usage, including AB-92's `cacheCreationTokens`/`cacheReadTokens`
   * when the provider reported them (absent, never fabricated as `0`, when
   * it did not — see {@link TokenUsage}).
   */
  usage: TokenUsage;
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
  /**
   * The agent that ran this run (AB-54 usage analytics grouping). Resolved
   * deterministically from `CreateRunRequest.agentName` (falling back to the
   * house default) at run-creation time. A run reattached after durable
   * recovery — whose process restarted, losing the in-memory resolution —
   * falls back to the tool-bubble-event heuristic and may be `undefined` for
   * a recovered run with no tool activity yet.
   */
  agentName: string | undefined;
  /**
   * The authenticated principal that created this run (e.g. `api-key:<id>`
   * or `static-token`), when the request carried an `x-auth-principal`
   * header. Captured only at creation time (in-memory, Layer A) — a run
   * reattached after durable recovery has no principal, since it is not
   * persisted durably. `undefined` for scheduler-fired runs, which have no
   * human principal.
   */
  principal: string | undefined;
  /**
   * Epoch-ms timestamp of the run's first recorded action (`run.started`).
   * `undefined` only in the vanishingly brief window between `store.register`
   * and the first action being appended.
   */
  startedAt: number | undefined;
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
  /**
   * Per-request output token cap; overrides the provider's construction-time
   * maximumTokens for this run. Maps to the provider's max_tokens parameter.
   */
  maximumTokens?: number;
  /**
   * The name of the agent to run. When provided, the bureau validates the name
   * is non-empty. In a multi-agent bureau this is used to select the correct
   * agent; in a single-agent bureau it is carried through as metadata.
   *
   * Typed dispatch endpoints (webhook ingress, OpenAI-compat) require this
   * field — callers must name the agent explicitly; there is no default-agent
   * fallback at the door.
   */
  agentName?: string;
  /**
   * The authenticated principal creating this run (e.g. `api-key:<id>` or
   * `static-token`), for AB-54 usage analytics attribution. The gateway
   * overwrites any caller-supplied value with the request's own
   * `x-auth-principal` header before calling `createRun` — never trust this
   * field verbatim from an untrusted request body.
   */
  principal?: string;
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
  | { type: 'stream:error'; runId: string; error: string }
  /**
   * AB-96 — a versioned run-lifecycle frame from `operative`'s run envelope
   * (`RunFrame`: run-started, step, assistant-chunk/final, tool-pre/post,
   * notification, run-finished). See {@link Bureau.getRunReport} for the
   * terminal `RunReport` embedded on the `run-finished` variant.
   */
  | { type: 'run-envelope'; runId: string; frame: RunFrame };

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_MAXIMUM_STEPS = 10;

// ── Durable Schedule ────────────────────────────────────────────────

/**
 * Parameters for registering a durable bureau schedule via
 * {@link Bureau.createSchedule}. The schedule fires the named `agentName`
 * on the given `spec`; each fire is either a fresh session (no `sessionId`)
 * or appended to the same persistent session (`sessionId` given).
 */
export interface DurableScheduleDefinition {
  /** Human-readable operator description stored with the schedule. */
  description?: string;
  /** Agent name to run on each schedule fire. */
  agentName: string;
  /** Input message delivered to the agent each fire. */
  input: string;
  /** Cron expression (e.g. `'0 9 * * *'`) or weft duration shorthand (e.g. `'6h'`, `'30s'`, `'1d'`). */
  spec: string;
  /**
   * When given, each schedule fire appends a run to this session — building a
   * recurring conversation that accumulates context across fires. When omitted,
   * each fire is a fresh standalone session.
   */
  sessionId?: string;
  /** Overlap policy when a prior fire is still running. Defaults to `'skip'`. */
  overlap?: 'skip' | 'allow';
}
