import type {
  AgentInput,
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
  SessionListOptions,
  SessionStore,
  SessionSummary,
  StopCondition,
  TokenUsage,
} from '@lostgradient/operative';
import type {
  CreateRunEngineOptions,
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
  SessionInputAdmissionOutcome,
  SessionInputAdmissionRequest,
} from '@lostgradient/operative/durable';
import type { LivenessSnapshot } from '@lostgradient/operative/liveness';
import type { SelectionPlan } from '@lostgradient/operative/providers';
import type { Store } from '@lostgradient/operative/store';
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
import type { Storage, StorageConfiguration, TextValueStore } from '@lostgradient/weft/storage';
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import type {
  AnyToolbox,
  PendingToolApproval,
  SignedPendingToolApproval,
  ToolRequestContext,
} from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import type { ToolPolicy } from 'interoperability';
import type {
  EventIteratorOptions,
  EventObservableOptions,
  ObservableLike,
  Observer,
  RuntimeServices,
  Subscription,
} from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';

import type {
  AgentDefinitions,
  AgentNames,
  AgentRunForName,
  BureauAgentCatalog,
} from './agent-catalog';
import type { AuditTrail } from './audit-trail';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from './durable-event-history';
import type { BureauEventMap } from './events';
import type { ModelCatalogService } from './model-catalog-refresh';
import type { BureauModelPolicyOptions, PlanSelectionRequest } from './model-policy';
import type { OnlineEvalSampler, OnlineEvalSamplerOptions } from './online-evals';
import type { SteeringCommandAdmissionOutcome, SteeringCommandRequest } from './steering';
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

// ── Diagnostics ──────────────────────────────────────────────────────

/**
 * A single operational diagnostic emitted by bureau internals — recovery
 * failures, live-frame listener exceptions, dispose errors, and persistence
 * failures. Distinct from {@link PersistenceOptions.onLog}: `onLog` carries
 * only replay-safe `ctx.log` records emitted BY durable workflow code, while
 * `BureauDiagnostic` covers bureau's own operational logging — the sites
 * that today write straight to `console.error`/`console.warn`.
 */
export interface BureauDiagnostic {
  level: 'warn' | 'error';
  /**
   * The subsystem the diagnostic originated from, e.g. `'recovery'`,
   * `'live-frames'`, `'dispose'`, `'webhook'`, `'audit-trail'`, or
   * `'session-persistence'`.
   */
  scope: string;
  message: string;
  cause?: unknown;
}

/** Sink for {@link BureauDiagnostic} events. See {@link BureauOptions.onDiagnostic}. */
export type DiagnosticSink = (diagnostic: BureauDiagnostic) => void;

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

export interface BureauOptions<D extends AgentDefinitions = AgentDefinitions> {
  /**
   * The typed agent catalog (AB-15, AB-22) — a plain literal map of agent
   * name to `RunnableAgent`, exposed read-only as {@link Bureau.agents} and
   * dispatched by name through {@link Bureau.run}. Required — pass `{}` for a
   * bureau that only uses the session/durability-backed `createRun` surface
   * and doesn't dispatch through the catalog at all. There is no
   * register/unregister lifecycle: the map is fixed for the bureau's
   * lifetime, independent of and additive to `createRun`/`generate`/
   * `provider` below (a bureau may use either, both, or neither surface).
   */
  agents: D;
  /**
   * AB-64/AB-250 — deployment/Bureau model-policy invariants and the
   * per-principal user configuration `Bureau.planSelection`/a run's
   * `SelectionGate` compose against, held in memory for the bureau's
   * lifetime. Named policy profiles are keys of `users` and of each
   * configuration's own `fallbackOrder`; there is no storage schema and no
   * migration. `BureauRunOptions` gains no field for any of this — see
   * AB-64's decision record, `## AB-15 and AB-22 boundaries (AC9)`.
   */
  modelPolicy?: BureauModelPolicyOptions;
  generate?: GenerateFunction;
  provider?: ProviderConfiguration;
  providers?: ProviderRouteConfiguration[];
  routing?: RoutingConfiguration;
  toolbox?: AnyToolbox;
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
  /**
   * Storage configuration or an already-constructed Weft storage adapter. Raw
   * adapters let platform packages such as `cloudflare` supply a Durable Object
   * SQLite backend; their lifecycle remains owned by the caller.
   */
  storage?: StorageConfiguration | Storage;
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
   * Recovered runs are registered through Weft's pre-resume recovery hook, so
   * {@link Bureau.getRun} and live event subscribers see them before resumed
   * user code advances.
   */
  durableExecution?: boolean;
  /**
   * Select how the durable engine's periodic maintenance is driven. The
   * default `'automatic'` profile uses in-process intervals. Cloudflare
   * Durable Objects and other serverless hosts should use `'manual'`, then
   * call {@link Bureau.runDurableMaintenance} from each alarm or Cron wake-up.
   */
  durableBackgroundTasks?: 'automatic' | 'manual';
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
  /** Host-owned authority check used before durable recovery resumes user code. */
  requestAuthorityValidator?: (context: ToolRequestContext) => boolean | Promise<boolean>;
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
  /**
   * F3 — opt into operative's `requestHumanInput` HITL tool for durable runs
   * (`createRun` only; has no effect without a durable engine composed). When
   * `true`, bureau adds a `requestHumanInput` tool to each durable run's
   * toolbox, bound to that run's OWN event emitter and its real `ctx.services`
   * object — the only wiring under which a `HumanWaitParkedEvent` the tool
   * dispatches actually reaches `subscribeLiveFrames`/`store` listeners
   * (including AB-13's flow-control `markParked`) and `listPendingReviews`
   * (AB-20). Omit (the default) to leave the toolbox as configured — this tool
   * is opt-in, never an ambient grant.
   */
  humanInput?: boolean;
  /**
   * AB-201 — opt into operative's `scheduleWakeup` self-scheduling tool for
   * durable runs (`createRun` only; has no effect without a durable engine
   * composed), mirroring {@link BureauOptions.humanInput}'s wiring exactly.
   * When `true`, bureau adds a `scheduleWakeup` tool to each durable run's
   * toolbox, bound to that run's real `ctx.services` object so a call
   * genuinely parks the workflow via `ctx.sleep` (AB-41's decision record)
   * rather than merely returning a success-shaped no-op. Omit (the default,
   * or `false`) to leave the toolbox as configured — this tool is opt-in,
   * never an ambient grant, and is simply absent from the toolbox rather than
   * wired to throw when disabled (mirroring `requestHumanInput`'s own
   * omission behavior). A standalone `scheduleWakeup` tool built outside
   * Bureau's composition with `durable: false` throws
   * `DurableCapabilityUnavailableError` instead (AB-41 / AB-43), unchanged by
   * this option.
   */
  wakeup?: boolean;
  stopWhen?: StopCondition | StopCondition[];
  sessionPersistenceRetryDelayMilliseconds?: number;
  sessionPersistenceSleep?: (milliseconds: number) => Promise<void>;
  /**
   * Injectable sleep used ONLY to bound `shutdown({ timeoutMilliseconds })`'s
   * wait (AB-207). Defaults to a real `setTimeout`-backed sleep, cleared via
   * `signal` once the real teardown chain wins the race first — otherwise a
   * `shutdown({ timeoutMilliseconds })` call on a bureau whose teardown
   * finishes quickly would still hold a live timer open for the full
   * duration. Tests supply a manually-controlled promise here instead of a
   * fake system clock — the same pattern `sessionPersistenceSleep` already
   * establishes — so the timeout-elapsed acceptance criterion never depends
   * on a real wall-clock wait; a test implementation should also honor
   * `signal` so it does not itself leak a pending timer/interval.
   */
  shutdownTimeoutSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
   * Multi-process ownership posture for the durable engine (AB-178). Omit for
   * the default `ownership: 'none'` — one bureau process per durable store,
   * enforced by infrastructure convention (one replica, a `Recreate` deploy)
   * rather than the engine itself, exactly as today. Has effect only when a
   * durable engine is composed.
   *
   * Passing `{ ownership: 'workflow-lease' }` lets more than one bureau
   * process safely share a durable store: Weft fences each workflow to
   * exactly one engine before its generator runs, so a second process racing
   * to resume the same workflow fails closed instead of double-executing it.
   *
   * **Do not enable this if your host relies on the scheduler's preemption
   * path** (a background task suspended and later resumed via
   * `submitSchedulerTask`/`createSchedule`'s overlap handling) — a reproduced
   * weft 0.23.1 defect makes `'workflow-lease'` incompatible with same-engine
   * `engine.suspend()`/`engine.resume()`, which Bureau's own scheduler uses
   * internally. See `CreateRunEngineOptions.ownership`'s JSDoc in
   * `@lostgradient/operative/durable` for the full repro and root cause.
   */
  durableOwnership?: Pick<
    CreateRunEngineOptions,
    'ownership' | 'workflowClaimTtlMs' | 'workflowClaimRenewIntervalMs'
  >;
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
  /**
   * Host sink for internal operational diagnostics — recovery failures,
   * live-frame listener exceptions, dispose errors, and persistence
   * failures (see {@link BureauDiagnostic}). Distinct from {@link onLog},
   * which only carries `ctx.log` records emitted by durable workflow code.
   * Omit to log to the console exactly as before (`console.error`/
   * `console.warn`, keyed by {@link BureauDiagnostic.level}). A throwing
   * sink falls back to the console for that one diagnostic without failing
   * the run.
   */
  onDiagnostic?: DiagnosticSink;
  /**
   * AB-42/AB-194 — per-session and per-principal backlog caps for pending
   * `SessionInputRecord`s admitted through {@link Bureau.submitSessionInput}.
   * Both are validated as positive integers at `createBureau()` construction
   * time, throwing `BureauError('...', 'BAD_REQUEST')` for a non-positive-integer
   * value (0, a negative number, or a non-integer). Omitting a field leaves it
   * unvalidated (no error) — {@link DEFAULT_SESSION_INPUT_BACKLOG_LIMIT} and
   * {@link DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT} are the values the
   * mailbox-backed admission path will apply for an omitted field once it
   * lands, not values `createBureau()` resolves or stores today.
   *
   * AB-42 fixes only that two independent caps exist over the not-yet-terminal
   * `SessionInputRecord`s for a session (and, separately, for one principal's
   * records against that session); it does not fix the numbers, and neither
   * cap is enforced by this issue's code paths — every reachable outcome here
   * is a pre-admission rejection, before any record (and so any backlog)
   * exists. Enforcement lands with the mailbox-backed `ab-42-bureau-b` slice.
   */
  sessionInput?: {
    readonly sessionBacklogLimit?: number;
    readonly principalBacklogLimit?: number;
  };
  /**
   * AB-246 — the model-catalog refresh service exposed as
   * {@link Bureau.modelCatalog}. Omit to let `createBureau` construct a
   * default `ModelCatalogService` over `@lostgradient/operative/providers`'s
   * static `createModelCatalog()` seed; pass one explicitly to share a
   * catalog across bureaus or to supply a non-default `descriptorSource`
   * (see `model-catalog-refresh.ts`'s `CatalogDescriptorSource` — the seam a
   * future live provider probe attaches to).
   */
  modelCatalog?: ModelCatalogService;
  /**
   * AB-92/AB-252/AB-260 — the injectable runtime-service seam: wall time,
   * monotonic time, timers, identifiers, randomness, and deferred-work
   * tracking. `createBureau` resolves `options.runtime ?? createDefaultRuntimeServices()`
   * exactly once, before any subsystem is constructed, and snapshots that
   * single instance into every run, session, schedule, scheduler task,
   * heartbeat tick, audit write, webhook delivery, and background evaluation
   * the bureau starts — two bureaus in one process given independent manual
   * runtimes never share a clock, an identifier sequence, or a deferred
   * ledger. Omit to use the real globals (`createDefaultRuntimeServices()`),
   * exactly as before this option existed. A test composes its own via
   * `createManualRuntimeServices` from `@lostgradient/operative/test` (or
   * `lifecycle`, which `@lostgradient/operative` re-exports it from).
   */
  runtime?: RuntimeServices;
}

/**
 * AB-42/AB-194 coordinator-chosen default for
 * {@link BureauOptions.sessionInput}'s `sessionBacklogLimit` — the per-session
 * cap over all not-yet-terminal `SessionInputRecord`s, applied when the caller
 * omits an explicit value. Not itself load-bearing for any AB-42 acceptance
 * criterion beyond being enforced once the mailbox-backed admission path lands.
 */
export const DEFAULT_SESSION_INPUT_BACKLOG_LIMIT = 32;

/**
 * AB-42/AB-194 coordinator-chosen default for
 * {@link BureauOptions.sessionInput}'s `principalBacklogLimit` — the per-principal
 * cap over one principal's `SessionInputRecord`s against a given session,
 * applied when the caller omits an explicit value.
 */
export const DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT = 128;

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
 * Shared review lifecycle vocabulary (AB-46) both {@link PendingToolApprovalReview}
 * and {@link PendingHumanWaitReview} report a `status` from. `listPendingReviews()`
 * only ever returns `'pending'` items; every other status surfaces through
 * `getReview(id)`'s audit-trail reconstruction or the audit trail itself.
 *
 * - `'pending'` — awaiting a decision.
 * - `'approved'` / `'denied'` — resolved via `resolveReview` with `decision: 'approve' | 'deny'`.
 * - `'rejected'` — resolved via `resolveReview` with `decision: 'reject'` (requires a reason).
 * - `'expired'` — a tool-approval review swept by `sweepExpiredReviews` past its binding's `expiresAt`.
 * - `'revoked'` — transitioned by `deleteRun`/`deleteSession` via `revokePendingApprovalsForRun`.
 * - `'canceled'` — transitioned by `abortRun`/`cancelDurableRun` via `revokePendingApprovalsForRun`.
 * - `'superseded'` — a tool-approval review whose `resumeApproval` re-gate produced a new `pendingApproval` for the same `callId`.
 */
export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'canceled'
  | 'superseded';

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
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
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
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
}

/** A single item in the gateway's review queue (AB-20). */
export type PendingReview = PendingToolApprovalReview | PendingHumanWaitReview;

export interface ResolveReviewInput {
  /** The {@link PendingReview.id} to resolve. */
  id: string;
  /**
   * `'reject'` (AB-46) is a `deny` outcome plus a REQUIRED caller-supplied
   * `reason`: `resolveReview` throws `BureauError('reject requires a reason',
   * 'BAD_REQUEST')` before any state change when `reason` is absent or empty,
   * for both review kinds.
   */
  decision: 'approve' | 'deny' | 'reject';
  /**
   * The authenticated principal making the decision (e.g. `api-key:<id>` or
   * `static-token`). Recorded in the audit trail for attribution — required,
   * not optional, so every resolution is attributable.
   */
  principal: string;
  /**
   * `tool-approval` approve only: override the tool call's arguments instead
   * of resuming with the originally-proposed ones. Ignored for `deny`/`reject`
   * and for `human-wait` reviews.
   */
  arguments?: unknown;
  /** `human-wait` approve only: the payload delivered with the signal. */
  payload?: unknown;
  /**
   * Optional human-readable note, recorded in the audit trail either way.
   * REQUIRED (non-empty) when `decision` is `'reject'`.
   */
  reason?: string;
}

export interface ResolveReviewResult {
  id: string;
  kind: PendingReview['kind'];
  decision: 'approve' | 'deny' | 'reject';
  /** The tool's `ToolExecutionResult` when a `tool-approval` was approved. */
  result?: unknown;
  /**
   * `tool-approval` reject only: echoes `input.reason` back so a caller
   * building the next manual run (per `create-agent.ts`'s docstring) can
   * splice it into the tool's `ToolExecutionResult`.
   */
  feedback?: string;
}

/**
 * Armorer's cleanup-outcome vocabulary
 * (`packages/armorer/src/execution-lifecycle.ts`'s `ExecutionCleanupOutcome`
 * `status`), reused verbatim per AB-34's vocabulary constraint — the same
 * reuse `CatalogRefreshCleanupAcknowledgement` makes in
 * `model-catalog-refresh.ts`.
 *
 * - `'completed'` — the owner's drain settled normally.
 * - `'failed'` — the owner's drain settled by rejecting; the failure is
 *   diagnosed and teardown continues past it.
 * - `'unresolved'` — a `shutdown({ timeoutMilliseconds })` wait elapsed
 *   before this owner's drain settled. The drain itself is not abandoned —
 *   only `shutdown()`'s wait for it is.
 * - `'not-required'` — this owner had nothing to release.
 */
export type CleanupAcknowledgement = 'not-required' | 'completed' | 'failed' | 'unresolved';

/**
 * Options for {@link Bureau.shutdown}. `policy` defaults to `'abort'` when
 * omitted (including when `options` itself is omitted) — matching
 * `dispose()`'s existing behavior.
 */
export interface BureauShutdownOptions {
  readonly policy?: 'abort' | 'drain';
  /**
   * Bounds `shutdown()`'s WAIT only — see {@link Bureau.shutdown}. Omit to
   * wait indefinitely.
   *
   * The wait itself sleeps on `BureauOptions.shutdownTimeoutSleep`, which
   * defaults to a sleep driven by this bureau's own resolved
   * `RuntimeServices.timers` (AB-260's deterministic contract) — never a
   * real timer, even under a real-globals bureau. Under a
   * `ManualRuntimeServices`, that means nothing advances this wait on its
   * own: the CALLER owns advancing the clock
   * (`runtime.advance(timeoutMilliseconds)`) far enough for it to elapse,
   * exactly as for any other timer-driven behavior. `bureau/test`'s
   * `BureauTestHarness.close(shutdownOptions)` is the one exception — it
   * owns that advance itself once `shutdown()` has armed the timer, so a
   * test built on the harness never needs to (Coordinator ruling on
   * AB-338).
   */
  readonly timeoutMilliseconds?: number;
}

/** One row of {@link BureauShutdownReport.owners} — one Bureau-composed subsystem's drain outcome. */
export interface BureauShutdownOwnerReport {
  /**
   * Which Bureau-composed subsystem this row reports on. A row is emitted
   * only for a subsystem this bureau actually composes — `'heartbeat'` is
   * reserved for the day Bureau composes one; no row carries it today.
   */
  readonly kind:
    | 'scheduler'
    | 'online-evals'
    | 'webhook-notifier'
    | 'audit-trail'
    | 'event-history'
    | 'durable-engine'
    | 'heartbeat';
  readonly id?: string;
  readonly outcome: CleanupAcknowledgement;
}

/**
 * Returned by {@link Bureau.shutdown}, modeled on armorer's
 * `ExecutionCleanupReport` shape (`packages/armorer/src/execution-lifecycle.ts`)
 * rather than a new report vocabulary.
 */
export interface BureauShutdownReport {
  readonly admissionClosed: true;
  readonly policy: 'abort' | 'drain';
  readonly requested: number;
  readonly completed: number;
  readonly failed: number;
  readonly unresolved: number;
  readonly notRequired: number;
  readonly owners: readonly BureauShutdownOwnerReport[];
}

/**
 * Per-call options accepted by {@link Bureau.run} — session/tracing/
 * attribution concerns that are properties of the CALL, not the agent (AB-15).
 * There is deliberately no `systemPrompt`, `maximumSteps`, or `maximumTokens`
 * override here: anything that shapes how the agent runs is fixed on the
 * catalog agent's own definition (`createAgent({ instructions, ... })`).
 */
export interface BureauRunOptions {
  /**
   * On the durable dispatch branch (a durable engine composed AND the named
   * agent supports definition resolution), seeds the `ActiveRun`'s
   * session-correlation key (defaulting to the minted run id when omitted).
   * A no-op on the direct/in-memory dispatch branch — `AgentRunContext`
   * (AB-15) carries no `sessionId` field, so a bare `RunnableAgent.run()`
   * has nowhere to observe it. Accepted without error on either branch;
   * unlike `principal`, this is deliberate rather than a gap, since a
   * caller cannot generally predict in advance which branch a given agent
   * will take.
   */
  sessionId?: string;
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  /**
   * Not yet honored by `bureau.run()`: `AgentRunContext` (AB-15) has no
   * `principal` field, so a bare `RunnableAgent.run()` has no attribution
   * surface to record it against — that is `createRun`'s job. Supplying a
   * value here throws synchronously (`BureauError` `BAD_REQUEST`) rather
   * than silently discarding it.
   */
  principal?: string;
}

export interface Bureau<D extends AgentDefinitions = AgentDefinitions> {
  readonly store: Store;
  readonly memory: Memory | undefined;
  readonly scheduler: Scheduler | undefined;
  readonly ready: boolean;
  /**
   * AB-246 — the model-catalog refresh service (AB-64's catalog, AB-34's
   * started-work control contract). Present regardless of `D`, matching the
   * rule that Bureau's administrative surface does not depend on the
   * registered agent set. `dispose()` awaits any in-flight refresh here
   * before reporting.
   */
  readonly modelCatalog: ModelCatalogService;

  /**
   * AB-64/AB-250 — builds a full `SelectionPlan` for `request` against this
   * bureau's CURRENT model catalog and `BureauOptions.modelPolicy`
   * configuration. Synchronous and side-effect-free: it starts no run,
   * refreshes no catalog, and dispatches no event — a caller can ask what
   * an Agent would use without any of the consequences of actually running
   * it. `request.principal` selects the per-principal `UserModelConfiguration`
   * from `modelPolicy.users`, the same value `BureauRunOptions.principal`
   * carries for an actual run; absent composes with no user layer.
   */
  planSelection(request: PlanSelectionRequest): SelectionPlan;

  /**
   * The typed agent catalog (AB-15, AB-22) — the immutable, read-only view
   * over `BureauOptions.agents`. `bureau.agents.has(name)` narrows a literal
   * string to a known agent name where TypeScript permits it.
   */
  readonly agents: BureauAgentCatalog<D>;

  /**
   * Dispatch to a named catalog agent (AB-15, AB-22) — synchronous, like
   * `RunnableAgent.run`: it returns the `AgentRun` handle immediately, never
   * `Promise<AgentRun>`, regardless of whether the named agent is a
   * `createLazyAgent` entry still resolving. Synchronous throws are limited
   * to an unknown `name`, a disposed bureau, and malformed `input`/`options`;
   * every other failure (session, provider, tool, policy, or abort) settles
   * through the returned handle.
   *
   * Independent of `createRun` below: `run` dispatches to a catalog
   * `RunnableAgent` (agent-owned generate/tools/durability by construction);
   * `createRun` keeps driving bureau-level `generate`/`provider` through the
   * session/durable-execution machinery. A bureau may use either, both, or
   * neither.
   *
   * When this bureau has a durable engine composed (a persistent `storage`
   * backend, or `durableExecution: true`) and the named agent supports the
   * definition-resolution capability (every `createAgent`/`createLazyAgent`
   * result does), the run is driven through that SAME durable engine so it
   * survives a crash and resumes — exactly like a `createRun` run. Otherwise
   * the agent's own in-memory `run()` is used directly.
   */
  run<TName extends AgentNames<D>>(
    name: TName,
    input: AgentInput,
    options?: BureauRunOptions,
  ): AgentRunForName<D, TName>;

  createRun(request: CreateRunRequest): Promise<RunSummary>;
  submitSchedulerTask(request: SubmitSchedulerTaskRequest): Promise<SubmitSchedulerTaskResponse>;
  listRuns(status?: string): RunSummary[];
  getRun(id: string): RunDetail | undefined;

  /**
   * Subscribes to live liveness updates for a run (AB-88/AB-214),
   * delegating to the underlying `ActiveRun`'s `subscribeSnapshot`. Delivers
   * the current snapshot synchronously before returning, then a new
   * snapshot on every revision change; already-terminal work delivers the
   * terminal snapshot once. A caller with only `getRun(id)` sees the
   * liveness observed at that call; a caller wanting live updates uses this
   * instead of polling `getRun`.
   *
   * Throws when `id` names no known run — matching `abortRun`'s unknown-id
   * behavior rather than `getRun`'s `undefined`-returning one, because there
   * is no snapshot value to hand back synchronously to `observer` for an id
   * this bureau has never registered.
   */
  subscribeRunSnapshot(
    runId: string,
    observer: (snapshot: LivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;

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
  deleteRun(id: string): Promise<void>;

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
   * Cancel a durable run that has no live, process-local `ActiveRun` (AB-37,
   * AB-205) — the boot-recovered fire that makes `abortRun` throw
   * `NOT_FOUND`. Asynchronous, unlike `abortRun`, and never rejects: every
   * failure mode resolves as a variant of {@link CancelDurableRunOutcome}
   * instead. `engine.cancel` alone is not proof a cancellation committed (it
   * resolves `void` unconditionally, whether it won or lost a race against
   * the workflow completing on its own), so this always re-reads
   * `getDurableRun(runId)` after `engine.cancel` resolves and reports
   * `'requested'` only when that re-read observes `status === 'cancelled'`;
   * any other terminal status resolves `'already-terminal'`.
   */
  cancelDurableRun(runId: string): Promise<CancelDurableRunOutcome>;

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

  /**
   * Run one host-driven durable-engine maintenance cycle. This fires due
   * timers and schedules and performs Weft's cleanup, retention, and alert
   * maintenance. Intended for `durableBackgroundTasks: 'manual'` hosts.
   * Returns `undefined` when no durable engine is composed.
   */
  runDurableMaintenance(now?: number): Promise<true | undefined>;

  listSessions(options?: SessionListOptions): Promise<SessionSummary[]>;
  getSession(id: string): Promise<AgentSession | undefined>;
  deleteSession(id: string): Promise<void>;

  /**
   * Deliver a fire-and-forget signal to a session's current in-flight durable run.
   * Maps to `engine.signal(runId, name, payload)`. Requires a durable engine and a
   * session store. Throws `BureauError('NOT_CONFIGURED', subject: 'durable')` when no durable
   * engine is composed; throws `BureauError('NOT_FOUND')` when the session has no current run.
   */
  signalSession(sessionId: string, name: string, payload?: unknown): Promise<void>;

  /**
   * Intended to send a validated, request/response update to a session's
   * current in-flight run, but currently unsupported: after the existing
   * `BureauError('NOT_CONFIGURED', subject: 'durable')` (no durable engine
   * composed) and `BureauError('NOT_FOUND')` (no active run) checks, this
   * unconditionally throws `BureauError('UNSUPPORTED_CAPABILITY')` (AB-41/
   * AB-192): the built-in `agentRun` workflow registers no `ctx.onUpdate`
   * handler, so this call can never reach `engine.update`. Kept, not
   * withdrawn — check {@link Bureau.sessionVerbCapabilities} to detect this
   * before calling.
   */
  updateSession(sessionId: string, name: string, payload?: unknown): Promise<unknown>;

  /**
   * Intended to query live state from a session's current in-flight run
   * without mutating it, but currently unsupported: after the existing
   * `BureauError('NOT_CONFIGURED', subject: 'durable')` (no durable engine
   * composed) and `BureauError('NOT_FOUND')` (no active run) checks, this
   * unconditionally throws `BureauError('UNSUPPORTED_CAPABILITY')` (AB-41/
   * AB-192): the built-in `agentRun` workflow registers no `ctx.onQuery`
   * handler, so this call can never reach `engine.query`. Kept, not
   * withdrawn — check {@link Bureau.sessionVerbCapabilities} to detect this
   * before calling.
   */
  querySession(sessionId: string, name: string, input?: unknown): Promise<unknown>;

  /**
   * AB-42/AB-194 — admit a caller's session input as a fifth session verb.
   * Pre-admission checks run in AB-42's fixed order: authorization, then
   * session lifecycle, then capability/capacity. An unauthorized caller or an
   * unknown `sessionId` returns `{ outcome: 'not-found' }` (indistinguishable
   * by design — the document's authorization-denial rule). An authorized
   * caller naming a session already in a terminal state returns
   * `{ outcome: 'session-terminal', sessionId }`.
   *
   * Until `ab-42-bureau-b` lands (WFT-84's durable application command
   * mailbox), every other authorized, non-terminal request unconditionally
   * returns `{ outcome: 'unsupported-capability', reason:
   * 'durable-mailbox-unavailable' }` — no `SessionInputRecord` is created and
   * no `id` is consumed by this method today. `admitted`/`replayed`/
   * `conflict`/`backlog-exhausted` are structurally unreachable until then.
   */
  submitSessionInput(
    sessionId: string,
    request: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome>;

  /**
   * AB-67/AB-199 — admit a `pause` or `resume` steering command as a sixth
   * session verb, scoped to an in-memory (process-local) session. Reads
   * authority and terminal status through the same mechanism
   * `submitSessionInput` uses ({@link isSessionAuthorityAuthorized},
   * {@link isSessionRunTerminal}): an unauthorized caller or unknown
   * `sessionId` returns `{ outcome: 'not-found' }`; an authorized caller
   * naming an already-terminal session returns `{ outcome: 'session-terminal',
   * sessionId }`.
   *
   * Every target other than `pause`/`resume` returns `{ outcome:
   * 'unsupported-capability', reason: 'selector-unavailable' }` — `ab-67-
   * bureau-b` owns admitting them (`policyRef` resolution through AB-66's
   * selector, `override`-against-catalog validation). A `pause`/`resume`
   * request against a session with `runtime.durable` configured likewise
   * returns `unsupported-capability`, with `reason:
   * 'durable-steering-unavailable'`: this method never holds process-local
   * pause/resume state a restart would lose.
   *
   * A `pause` against an authorized, non-terminal, in-memory session is
   * accepted, increments the session's `configVersion` by exactly one, and
   * is idempotent against a second `pause` while the first is still
   * `accepted`/`applied` (no second increment). A `resume` against a session
   * that is not currently paused is accepted as a no-op, matching the
   * idempotent-abort precedent at
   * `documentation/operative-type-safe-api.md:765`. An `accepted`
   * pause/resume transitions to `failed` with `SteeringCommandFailure.reason
   * = 'run-terminal'` if the targeted run aborts or completes before its
   * `runStep` boundary is reached. An exact retry of the same
   * `(principal, id)` with an identical `requestedValue` replays the
   * original command's current state; a same-`id`, different-`requestedValue`
   * reuse returns a typed conflict.
   */
  submitSteeringCommand(
    sessionId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome>;

  /**
   * Synchronous, constant capability discovery for the three session verbs
   * (AB-192) — lets a caller check `update`/`query` support before calling
   * either method, rather than only by catching `UNSUPPORTED_CAPABILITY`.
   * `signal` is `true` (`signalSession` has a real delivery path); `update`
   * and `query` are `false` because the built-in `agentRun` workflow
   * registers no `ctx.onUpdate`/`ctx.onQuery` handler. Computed once; not a
   * function of runtime configuration.
   */
  readonly sessionVerbCapabilities: {
    readonly signal: true;
    readonly update: false;
    readonly query: false;
  };

  /**
   * List every parked run awaiting human review (AB-20): armorer's
   * `needs_approval` tool-approval flow AND durable `requestHumanInput`
   * (`ctx.waitForSignal`) waits, across all live runs. Newest requests last
   * are NOT guaranteed — order is run-registration order, not age order.
   * Excludes items already resolved via `resolveReview` (approved, denied, or
   * rejected), even if the underlying run has not produced further activity.
   * Also excludes any `tool-approval` review whose binding's `expiresAt` is at
   * or before the current clock time (AB-46) — a read-time filter with no
   * write; see `sweepExpiredReviews` for the write that transitions it to
   * `'expired'`.
   */
  listPendingReviews(): PendingReview[];

  /**
   * Look up one review by id, live or resolved (AB-46). For a still-pending
   * id this is `listPendingReviews()`'s live scan. For a resolved id, this
   * reconstructs `PendingReview & { status }` from the chronologically-last
   * `review.*` audit-trail record matching `detail.review.id === id` —
   * `undefined` when no audit trail is configured (ephemeral bureau) or when
   * `id` matches nothing at all.
   */
  getReview(id: string): Promise<(PendingReview & { status: ReviewStatus }) | undefined>;

  /**
   * Approve, deny, or reject a pending review (AB-46). Approve resumes the
   * run: a `tool-approval` calls `Toolbox.resumeApproval` on the bureau's
   * toolbox and returns its `ToolExecutionResult`; a `human-wait` calls
   * `signalSession` with the parked signal name. Deny records the decision
   * without resuming anything for `tool-approval` (the binding is revoked; no
   * run to continue), and delivers `{ __abDenied: true, reason? }` on the
   * parked signal for `human-wait`, continuing that run one generation step.
   * Reject is deny plus a REQUIRED `input.reason`: `resolveReview` throws
   * `BureauError('reject requires a reason', 'BAD_REQUEST')` before any state
   * change when it is absent or empty. A `tool-approval` reject echoes
   * `input.reason` on `ResolveReviewResult.feedback`; a `human-wait` reject
   * delivers `{ __abRejected: true, reason: input.reason }` on the signal.
   * Every resolution is recorded in the audit trail attributed to
   * `input.principal`.
   *
   * Throws `BureauError('NOT_FOUND')` when `input.id` does not match a
   * currently pending review (including an already-resolved one).
   */
  resolveReview(input: ResolveReviewInput): Promise<ResolveReviewResult>;

  /**
   * Host-driven expiry sweep (AB-46): scans every tool-approval review past
   * its binding's `expiresAt` that is not already resolved, transitions each
   * to `status: 'expired'`, writes one `review.tool-approval.expired` audit
   * entry per review attributed to the synthetic principal
   * `'system:expiry-sweep'`, and returns the count swept. Calling it twice in
   * a row without new expirations returns `0` the second time. `human-wait`
   * reviews are never swept — their expiry is Weft's own wait timeout.
   * `now` defaults to the bureau's own clock.
   */
  sweepExpiredReviews(now?: number): Promise<number>;

  /**
   * Installs the host-owned authority freshness check used immediately before
   * a delayed tool approval is resumed. Transports that issue revocable
   * credentials should configure this when they attach to the bureau.
   */
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;

  /** Waits for any deferred durable recovery released by validator attachment. */
  waitForRecovery?(): Promise<void>;

  /**
   * Returns the current host-owned authority freshness check so transports can
   * compose their own revocation checks without replacing construction-time
   * host validation.
   */
  getRequestAuthorityValidator():
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined;

  /**
   * Register a durable recurring schedule via `engine.schedule(...)`.
   * Throws `ScheduleLocatorUnavailableError` when the schedule was created
   * but its summary could not be immediately retrieved — the schedule IS
   * registered in that case, only its locator failed. Returns `undefined`
   * when no durable engine is composed.
   */
  createSchedule(definition: DurableScheduleDefinition): Promise<ScheduleSummary | undefined>;

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

  dispose(): Promise<void>;

  /**
   * Awaited drain of everything Bureau owns (AB-207/AB-37). `dispose()` is a
   * thin wrapper — `shutdown({ policy: 'abort' })` awaited to completion —
   * kept for the existing `Promise<void>` external shape; prefer `shutdown()`
   * directly when the report is useful.
   *
   * `'abort'` (the default when `policy` is omitted) aborts every active run
   * immediately, then awaits every drain. `'drain'` closes admission
   * identically but lets every already-active caller-owned agent run
   * (`bureau.run`/session-owned) reach its own natural terminal result while
   * Bureau-owned background work (scheduler, online-evals, webhook notifier,
   * audit trail) is stopped/awaited exactly as under `'abort'`.
   *
   * `timeoutMilliseconds` bounds the WAIT only: on elapse, `shutdown()`
   * resolves (never rejects) with every already-settled owner's real outcome
   * and every still-outstanding owner reported `'unresolved'` — the
   * underlying teardown keeps running to completion in the background, it is
   * never abandoned. Omitting it waits indefinitely, matching today's
   * `dispose()`. That wait sleeps on the RESOLVED runtime
   * (`RuntimeServices.timers`, never a real timer directly — see
   * {@link BureauShutdownOptions.timeoutMilliseconds}), so under a manual
   * runtime the caller owns advancing the clock far enough for a bounded
   * wait to elapse — `bureau/test`'s `BureauTestHarness.close()` is the one
   * built-in exception, owning that advance itself (Coordinator ruling on
   * AB-338).
   *
   * Calling `shutdown()` (or `dispose()`) more than once is idempotent: every
   * call after the first returns the same cached report promise, regardless
   * of the policy passed to the later call.
   */
  shutdown(options?: BureauShutdownOptions): Promise<BureauShutdownReport>;

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

  /**
   * Pages `owner`'s durable event history (AB-91's `ab91-01` slice,
   * AB-310) — a bounded, sequence-ordered page of events after the
   * exclusive `since` cursor, a {@link DurableEventGap} when `since`
   * predates the store's retention floor, or
   * `{ outcome: 'unsupported-capability', reason: 'no-persistent-storage'
   * }` for an ephemeral bureau (no persistent storage backend
   * configured) — matching the `unsupported-capability` locator outcome
   * AB-91's own source spec and AB-42's precedent both use for a missing
   * durable backend.
   *
   * A producer sinks the run/session/schedule-fire families AB-87's matrix
   * classifies as durable into this store (AB-311's coordinator amendment
   * — see `durable-event-history.ts`'s `createDurableEventProducer` doc
   * comment for exactly which events, and why a `schedule.created`/
   * `paused`/`resumed`/`cancelled` definition event is not among them).
   *
   * AB-313 adds two outcomes for `owner.kind` `'run'`/`'session'` (schedule
   * owners are unaffected — no ownership/authorization concept exists for
   * them yet):
   *
   * - `options.principal`, when provided, is checked against the run's
   *   recorded `principal` (`AgentRun`'s own attribution) or the session's
   *   recorded request authority (`isSessionAuthorityAuthorized`, AB-42's
   *   precedent). A caller whose principal does not match an owner with a
   *   RECORDED principal gets `{ outcome: 'not-found' }` — the same
   *   not-found-shaped denial `submitSessionInput` (AB-194) uses, so an
   *   unauthorized caller cannot distinguish "wrong id" from "exists, not
   *   yours." An owner with NO recorded principal is open (matches every
   *   existing session verb's "no recorded authority" rule); omitting
   *   `options.principal` entirely skips the check (an internal/trusted
   *   caller, or a gateway request from a privileged connection).
   * - When the owner's live Bureau record is gone (the session was
   *   deleted, or the run's record was removed via `deleteRun`) but this
   *   store still holds committed events for it, this returns
   *   `{ outcome: 'deleted-aggregate', owner, events, hasMore, nextCursor?
   *   }` instead of an ordinary page — distinguishable from BOTH an
   *   ordinary empty page (an id nothing was ever recorded under) and
   *   `not-found` (no committed events at all): AB-87's retention/deletion
   *   posture is that deleting the owner record never deletes its
   *   history, so the events remain queryable through this same call
   *   rather than requiring a second one.
   */
  eventHistory(
    owner: DurableEventOwner,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;

  /**
   * Replays `owner`'s durable event history from the exclusive `since`
   * cursor, then transitions to live delivery with no gap and no
   * duplicate at the handoff (AB-311) — see
   * `durable-event-history.ts`'s `DurableEventHistory.subscribeEventHistory`
   * doc comment for the full race-freedom, disposal, and error-isolation
   * contract. Returns an already-closed, never-delivering `Subscription`
   * for an ephemeral bureau (no persistent storage backend configured) —
   * a caller that must distinguish "unsupported" from "supported but
   * empty" calls `eventHistory()` first.
   */
  subscribeEventHistory(
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
}

/**
 * Returned by {@link Bureau.eventHistory} when the bureau has no
 * persistent storage backend configured.
 */
export interface EventHistoryUnsupportedOutcome {
  readonly outcome: 'unsupported-capability';
  readonly reason: 'no-persistent-storage';
}

/**
 * Returned by {@link Bureau.eventHistory} (AB-313) when `options.principal`
 * is provided and does not match `owner`'s recorded principal — the same
 * not-found-shaped denial `submitSessionInput` (AB-42/AB-194) returns, so an
 * unauthorized caller cannot distinguish "no such run/session" from "exists,
 * not yours."
 */
export interface EventHistoryNotFoundOutcome {
  readonly outcome: 'not-found';
}

/**
 * Returned by {@link Bureau.eventHistory} (AB-313) when `owner`'s live
 * Bureau record is gone (`deleteRun`, or a deleted session) but this store
 * still holds committed durable events for it — distinguishable from both
 * an ordinary empty {@link DurableEventPage} (an id nothing was ever
 * recorded under) and {@link EventHistoryNotFoundOutcome} (no committed
 * events at all). Carries the same page fields as `DurableEventPage` so the
 * already-committed events remain queryable through this one call — AB-87's
 * retention/deletion posture is that deleting the owner record never
 * deletes its history.
 */
export interface EventHistoryDeletedAggregateOutcome extends DurableEventPage {
  readonly outcome: 'deleted-aggregate';
  readonly owner: DurableEventOwner;
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

/**
 * Resolution of a {@link Bureau.cancelDurableRun} call (AB-37, AB-205).
 * Never a rejection — every failure mode, including one raised by the engine
 * itself, is represented as a variant here instead.
 */
export type CancelDurableRunOutcome =
  | { readonly status: 'requested' }
  | { readonly status: 'already-terminal' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unsupported-capability' }
  | { readonly status: 'failed'; readonly error: unknown };

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
  /**
   * The run's current liveness snapshot (AB-88/AB-214), plain-data and
   * JSON-safe. `getRun(id)` carries the value observed at call time; a
   * caller wanting live updates calls `bureau.subscribeRunSnapshot(id, ...)`
   * instead of polling `getRun`.
   */
  liveness: LivenessSnapshot;
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
  /** Authenticated, request-scoped authority forwarded to Armorer tool execution. */
  requestContext?: ToolRequestContext;
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

/**
 * Live stream frame shapes as produced by {@link streamEventToFrame}, before
 * the per-run sequence stamp is applied. Kept separate from {@link ServerFrame}
 * so the frame-construction layer (`streamEventToFrame`) never has to know
 * about sequencing — the bureau frame layer (`create-bureau.ts`) stamps
 * `runSeq` once, at the single point where frames are handed to
 * `emitLiveFrame`. See {@link ServerFrame} for the wire-level (stamped) shape.
 */
export type StreamFrame =
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

/**
 * AB-96 — a versioned run-lifecycle frame from `operative`'s run envelope
 * (`RunFrame`: run-started, step, assistant-chunk/final, tool-pre/post,
 * notification, run-finished). See {@link Bureau.getRunReport} for the
 * terminal `RunReport` embedded on the `run-finished` variant.
 *
 * Deliberately NOT part of {@link StreamFrame}/the AB-15 `runSeq` replay
 * contract: `create-bureau.ts` emits these without a `runSeq` stamp (they
 * carry their own envelope-level sequencing via `RunFrame`), so
 * `getRunSeq`/the live-frame replay buffer correctly treat them as
 * non-replayable, same as before AB-15 added `runSeq`.
 */
export type RunEnvelopeFrame = { type: 'run-envelope'; runId: string; frame: RunFrame };

export type ServerFrame =
  | {
      type: 'event';
      runId: string;
      event: string;
      detail: unknown;
      /**
       * The store's global action counter (unique across all runs in this
       * store's lifetime). Used by the REST `/api/v1/runs/:id` timeline to
       * dedupe against live frames already rendered — see
       * `use-run-detail.svelte.ts`. NOT a replay cursor; use {@link runSeq}
       * for that.
       */
      sequence: number;
      timestamp: number;
      /**
       * Monotonic per-run sequence number (AB-15), starting at 1 for the
       * first live frame emitted for `runId` and incrementing by 1 for every
       * subsequent run-scoped frame (`event` and `stream:*`) emitted for that
       * same run. This is the replay cursor: a reconnecting client reports
       * the highest `runSeq` it has already seen for a run (WS `subscribe.since`,
       * SSE `Last-Event-ID`) and the door replays buffered frames with a
       * higher `runSeq` before resuming the live feed.
       */
      runSeq: number;
    }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'scheduler.state'; state: SchedulerState }
  | { type: 'scheduler.task.preempted'; taskId: string; reason: string; state: SchedulerState }
  | (StreamFrame & { runSeq: number })
  | RunEnvelopeFrame
  | {
      /**
       * A durable event delivered through the gateway's reconnect-across-
       * restart fallback (AB-312), never through the ordinary in-memory
       * replay buffer this file's `runSeq` doc comment describes. Sourced
       * from `Bureau.subscribeEventHistory`'s replay-then-tail delivery
       * once a client's resume cursor is older than the live buffer's own
       * floor (or the buffer holds nothing at all, e.g. after a Gateway
       * restart) — see `packages/gateway/src/live-events.ts`'s
       * `durableEnvelopeToServerFrame`.
       *
       * Deliberately carries NO `runSeq`: it is not part of the AB-15
       * in-memory replay-buffer cursor space (a `DurableEventEnvelope`'s
       * own `sequence`/`cursor` is Weft's fleet-global position, not a
       * per-run counter, and the two cannot be translated into each
       * other — see this issue's own doc comment on the fallback path).
       * Never buffered and never advances a client's live `runSeq`
       * cursor, the same as every other non-`runSeq`-bearing frame.
       */
      type: 'durable-event';
      runId: string;
      /** The durable envelope's own `kind` (e.g. `'run.completed'`). */
      event: string;
      /** The durable envelope's own `payload`. */
      detail: unknown;
      /** The durable envelope's own opaque `cursor` — never parsed, only round-tripped. */
      cursor: string;
      schemaVersion: number;
      /** The durable envelope's own `emittedAtMs`. */
      timestamp: number;
    };

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
