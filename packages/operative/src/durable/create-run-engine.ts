import type {
  AnyWorkflowDefinition,
  CheckpointSizeWarningEvent,
  HistoryPolicy,
  PayloadSizePolicy,
  RegistryAgnosticEngine,
  WorkflowLogRecord,
  WorkflowServicesResolution,
  WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import { Engine } from '@lostgradient/weft';
// `MetricsCollector` is NOT re-exported from the `@lostgradient/weft` root barrel
// (only the metrics factories are) — the class lives on the `/observability`
// subpath, so the type must be imported from there.
import type { MetricsCollector, ObservabilityOptions } from '@lostgradient/weft/observability';
import { createObservabilityInterceptors } from '@lostgradient/weft/observability';
import type { Storage } from '@lostgradient/weft/storage';
import { textValueStore } from '@lostgradient/weft/storage';

import { WorkflowVersionMismatchEvent } from '../events';
import type { CheckpointStore } from './checkpoint-store';
import { createCheckpointStore } from './checkpoint-store';
import {
  attachDurableHeartbeatServicesStore,
  createDurableHeartbeatServicesStore,
  createDurableHeartbeatTickWorkflow,
  DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
  resolveDurableHeartbeatTickServices,
} from './durable-heartbeat-tick-workflow';
import { createStorageActivities } from './storage-activities';

/**
 * Options for {@link createRunEngine}.
 */
export interface CreateRunEngineOptions {
  /**
   * The raw Weft {@link Storage} backend the engine persists checkpoints to.
   *
   * This MUST be the same backend the rest of agent-bureau wraps with
   * `textValueStore` (sessions, cache, identity), so durable run state and
   * application data share one store — Weft requires one engine per durable
   * store. Use a persistent backend (`SQLiteStorage`) when durability matters;
   * `MemoryStorage` loses checkpoints with the process.
   */
  storage: Storage;

  /**
   * The durable agent-run workflow definition (`run-workflow.ts`'s `agentRun`).
   * Injected rather than imported so the engine wiring can be built and tested
   * independently of the workflow body (which depends on the loop refactor).
   */
  runWorkflow: AnyWorkflowDefinition;

  /**
   * Recover in-flight workflows on boot. Defaults to `true` (Weft's default):
   * a fresh engine resumes any `agentRun` workflows a previous process left
   * mid-flight. Pass `false` for isolated tests.
   */
  recover?: boolean;

  /**
   * Single-writer ownership posture over the shared durable store (AB-178).
   * Defaults to `'none'` — today's behavior: one engine per store, enforced by
   * infrastructure convention (one replica, a `Recreate` deploy) rather than
   * the engine itself, exactly as AB-39 recorded.
   *
   * Pass `'workflow-lease'` to let more than one engine share a store safely:
   * Weft claims each workflow for exactly one engine before its generator
   * runs (per-workflow fencing, not a single store-wide lock), so a second
   * engine racing to resume the same workflow fails closed with
   * `WorkflowClaimUnavailableError` instead of double-executing it.
   *
   * Two things to weigh before opting in:
   * - **Storage requirement.** The backend must support the `conditionalBatch`
   *   capability. `MemoryStorage` and `SQLiteStorage` both do; verify any
   *   other backend before enabling this.
   * - **Known weft 0.23.1 defect — incompatible with the scheduler's
   *   suspend/resume preemption path.** `engine.suspend(workflowId)` releases
   *   the workflow's ownership claim as a side effect of reusing the
   *   terminal-commit code path (`commitExternalTerminalWorkflowStateOperations`
   *   → `buildExternalTerminalRotationFragment`), even though suspend is
   *   documented as non-terminal and later resumable. A same-engine
   *   `engine.resume(workflowId)` right after then throws
   *   `WorkflowClaimUnavailableError` (`holder-absent`) instead of silently
   *   re-acquiring, because `acquireStandaloneClaimBeforeResume` trusts its
   *   stale cached epoch and never falls through to a fresh `registry.acquire()`.
   *   Reproduced directly against `@lostgradient/weft@0.23.1` with no
   *   agent-bureau code involved. This breaks `createScheduler`'s
   *   `suspendAndDetach` → `resumeDurableRunResult` preemption flow
   *   (`packages/operative/src/scheduler/create-scheduler.ts`), so do not set
   *   `ownership: 'workflow-lease'` on an engine a scheduler with preemption
   *   attaches to until weft fixes this. `'none'` is unaffected — this is why
   *   `'none'` stays the default rather than `'workflow-lease'` becoming
   *   unconditional.
   *
   * `'lease'` (Weft's single store-wide lock) is intentionally not exposed
   * here: it solves a different problem (clean handoff during a rolling
   * deploy of ONE engine) than AB-178's ask (several engines sharing one
   * store), and per Weft's own docs is incompatible with
   * `backgroundTasks: 'manual'`, unlike `'workflow-lease'`.
   */
  ownership?: 'none' | 'workflow-lease';

  /**
   * Per-workflow claim time-to-live under `ownership: 'workflow-lease'`
   * (default 30s, Weft's own default). Ignored when `ownership` is not
   * `'workflow-lease'`. Lowering this shortens how long a surviving engine
   * must wait before it can adopt a crashed engine's claimed workflows —
   * mainly useful for tests exercising crash-and-adopt without a real 30s
   * wait.
   */
  workflowClaimTtlMs?: number;

  /**
   * Per-workflow claim renewal interval under `ownership: 'workflow-lease'`
   * (default 5s, Weft's own default). Ignored when `ownership` is not
   * `'workflow-lease'`.
   */
  workflowClaimRenewIntervalMs?: number;

  /**
   * Select how Weft's periodic maintenance is driven. The default
   * `'automatic'` profile uses in-process intervals. Use `'manual'` in
   * serverless hosts such as Cloudflare Durable Objects, then call
   * `engine.runMaintenance()` from each alarm or Cron wake-up.
   */
  backgroundTasks?: 'automatic' | 'manual';

  /**
   * Arm Weft's durable-timer polling loop, independent of {@link recover}
   * in Weft. `recover` decides *who drives `recoverAll`*; `startScheduler`
   * decides *whether `ctx.sleep(...)` / `engine.schedule(...)` timers fire*. It
   * defaults to `false` when {@link backgroundTasks} is `'manual'`; otherwise it
   * follows `recover !== false`, so the common in-process host keeps prior
   * behavior. An explicit value always wins.
   */
  startScheduler?: boolean;

  /**
   * Re-provide a recovered run's non-serializable {@link DurableRunDeps} on a
   * fresh-process resume. Weft calls this resolver per recovered inline run
   * (those launched WITH `services`) BEFORE the generator advances, so the
   * rebuilt `generate`/`toolbox`/`hooks` are in place when the workflow reads
   * `ctx.services`. Returning `{ status: 'unavailable' }` fails just that one run
   * (terminal `failed`) without aborting recovery or the engine. Omit for an
   * engine that never resumes cross-process (e.g. isolated tests).
   */
  resolveWorkflowServices?: (
    info: WorkflowServicesResolverInfo,
  ) => WorkflowServicesResolution | Promise<WorkflowServicesResolution>;

  /**
   * A pre-built {@link CheckpointStore}. When omitted, one is created over a
   * `textValueStore` view of `storage`. Inject one to share the exact store the
   * rest of composition already built.
   */
  checkpointStore?: CheckpointStore;

  /**
   * Opt into OpenTelemetry spans + metrics for durable workflows and activities.
   * When `true`, wires Weft's `createObservabilityInterceptors()` with this engine
   * as the `eventTarget` (so root workflow spans close on terminal lifecycle
   * events rather than accumulating until disposal). Pass an
   * {@link ObservabilityOptions} object to customize the tracer name, payload
   * recording, etc. `@opentelemetry/api` is an optional peer dependency — without
   * it every span operation is a documented no-op with near-zero overhead, so
   * enabling this is safe even before a telemetry backend exists. The metrics
   * handle and the cleanup `dispose` are returned on {@link RunEngine.observability}.
   */
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>;

  /**
   * Host sink for `ctx.log` records emitted by durable workflows (Weft 0.4.0
   * structured logging). Receives every replay-safe log record from inline and
   * worker execution. A throwing sink falls back to console without failing the
   * workflow. Omit to leave logs going to the host console.
   */
  onLog?: (record: WorkflowLogRecord) => void;

  /**
   * History circuit breaker. An agent run checkpoints its full transcript per
   * step, so a long run's event-log grows with steps × message size; activation
   * replays that log (cost is O(history)), and an unbounded log can stall the
   * shared single-process engine. When `history.maxEvents` is set, a run whose
   * durable event-log would exceed it is force-terminated as `timed-out` with
   * `terminationReason === 'history-circuit-breaker'` — which the adapter
   * classifies distinctly from a genuine deadline timeout. Omit to disable.
   */
  history?: HistoryPolicy;

  /**
   * Early-warning threshold (bytes) for checkpoint payload size. When a
   * checkpoint write exceeds it, the engine dispatches a
   * `CheckpointSizeWarningEvent`; pass {@link onCheckpointSizeWarning} to observe
   * it (a silent warning event is no warning). Does not terminate the run.
   */
  checkpointSizeWarningThreshold?: number;

  /** How many past checkpoints to retain per run (storage-growth control). */
  checkpointHistory?: number;

  /** Admission cap on a single checkpoint payload (`PayloadSizeExceededError`). */
  payloadSize?: PayloadSizePolicy;

  /**
   * Subscriber for `CheckpointSizeWarningEvent` (`checkpoint:size-warning`). Wired
   * to the engine when provided, so a checkpoint approaching pathological size is
   * surfaced rather than silently dispatched. Pairs with
   * {@link checkpointSizeWarningThreshold}.
   */
  onCheckpointSizeWarning?: (event: CheckpointSizeWarningEvent) => void;

  /**
   * Override the durable-timer scheduler's poll interval in milliseconds.
   * Defaults to the Weft Engine default (1000ms). Useful in tests that need to
   * detect whether the scheduler is inadvertently armed: a short interval ensures
   * a real-time poller fires an expired timer within a tight observation window.
   */
  schedulerPollIntervalMs?: number;

  /**
   * Caller-supplied version identifier for the currently-deployed `agentRun`
   * workflow code (e.g. the app's package version or a deploy SHA) — AB-10,
   * workflow versioning for in-flight durable runs. On every recovered run,
   * compared against the version stamped into that run's checkpoint at
   * creation (`createRunWorkflow`'s `version` option, which SHOULD be passed
   * the same value). A mismatch fires {@link onWorkflowVersionMismatch}; it
   * never blocks or alters recovery (pin-and-warn).
   *
   * @remarks
   * Deliberately NOT implemented via Weft's own `WorkflowDefinition.version`
   * field. Weft already tracks a per-workflow version and throws
   * `VersionMismatchError` on a recovery mismatch — but that throw propagates
   * out of `engine.recoverAll()` uncaught (its per-run try/catch only special-
   * cases `RegExpExtensionDecodeError`), aborting recovery for every OTHER
   * in-flight run in the same batch, not just the mismatched one. That
   * fleet-wide-abort failure mode is unsafe for a production deploy (the
   * whole point of versioning is to keep deploying safely with runs in
   * flight), so this option implements an independent, non-throwing
   * stamp-and-compare at the checkpoint-store layer instead. Filed upstream:
   * weft ticket requesting `recoverAll` fail just the mismatched run (like
   * `resolveWorkflowServices` returning `'unavailable'` already does) and/or
   * exporting a public pre-flight version-check surface.
   */
  runWorkflowVersion?: string;

  /**
   * Fired once per recovered run whose checkpointed `workflowVersion` differs
   * from {@link runWorkflowVersion}. Both sides must be set for a comparison to
   * run — a run with no stamped version, or an engine with no configured
   * `runWorkflowVersion`, is never flagged. See {@link runWorkflowVersion} for
   * the pin-and-warn semantics.
   */
  onWorkflowVersionMismatch?: (event: WorkflowVersionMismatchEvent) => void;
}

/**
 * The observability handle returned when {@link CreateRunEngineOptions.observability}
 * is enabled: the metrics collector for reading counters/histograms/gauges, and a
 * `dispose` that ends still-open spans and unsubscribes the engine lifecycle
 * listeners. `dispose` MUST run before the engine is disposed so the engine's
 * terminal events still reach the span-closing listeners.
 */
export interface RunEngineObservability {
  metrics: MetricsCollector;
  dispose: () => void;
}

/**
 * Re-exported for convenience so durable-layer callers can import the engine
 * type from the same module that builds it, rather than reaching into
 * `@lostgradient/weft` directly. This is the upstream registry-erased engine
 * type (Weft's `Engine` with its two chained-builder registration methods,
 * `register`/`registerWorkflows`, removed) — see its JSDoc in
 * `@lostgradient/weft` for why the removal, rather than widening the registry
 * generics, is what makes a concretely narrowed `Engine.create({ workflows })`
 * result assignable here without a cast.
 */
export type { RegistryAgnosticEngine };

/**
 * The durable run engine plus the checkpoint store it was built with, so callers
 * can read/write checkpoints through the same view the activities use.
 */
export interface RunEngine {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
  /**
   * Present only when {@link CreateRunEngineOptions.observability} was enabled.
   * Carries the metrics collector and a `dispose` the owner must call BEFORE
   * disposing the engine.
   */
  observability?: RunEngineObservability;
}

/**
 * Builds the durable run {@link Engine}: registers the `agentRun` workflow and
 * the storage activities (load/save cursor, conversation, and step records),
 * wired to a single durable backend. Tool execution is NOT an activity — it runs
 * in-process inside `runStep`, the same code path the in-memory loop uses.
 *
 * @remarks
 * `recover` defaults to `true`, so on boot the engine resumes any `agentRun`
 * workflows a previous process left in flight. Each recovered run's
 * non-serializable {@link DurableRunDeps} are re-provided through
 * {@link CreateRunEngineOptions.resolveWorkflowServices}, which Weft fires before
 * the resumed generator reads `ctx.services` — no module-global registry.
 *
 * Weft's durable-timer poller follows {@link CreateRunEngineOptions.startScheduler}.
 * Manual background tasks default it off; otherwise it follows `recover !==
 * false`. An automatic host that owns recovery (`recover: false`) must pass
 * `startScheduler: true` so `ctx.sleep(...)` / `engine.schedule(...)` timers
 * still fire.
 *
 * History/checkpoint guardrails ({@link CreateRunEngineOptions.history},
 * `checkpointSizeWarningThreshold`, `checkpointHistory`, `payloadSize`) are
 * threaded into the engine; a `history.maxEvents` breach surfaces as a
 * `timed-out` terminal with `terminationReason: 'history-circuit-breaker'`, which
 * the active-run adapter classifies as `error` (not a deadline timeout).
 *
 * **Multi-process safety (AB-178).** {@link CreateRunEngineOptions.ownership}
 * is host-configurable, defaulting to `'none'` (today's behavior, unchanged).
 * Passing `'workflow-lease'` claims every workflow for exactly one engine
 * before its generator runs, so a second engine pointed at the same store
 * fails closed on that workflow instead of double-executing it — see the
 * `ownership` field in the `Engine.create` call below for why this is
 * opt-in rather than the new default, and for the storage capability it
 * requires.
 */
export async function createRunEngine(options: CreateRunEngineOptions): Promise<RunEngine> {
  const checkpointStore =
    options.checkpointStore ?? createCheckpointStoreFromStorage(options.storage);
  const storageActivities = createStorageActivities(checkpointStore);
  const durableHeartbeatServicesStore = createDurableHeartbeatServicesStore();
  const startScheduler =
    options.startScheduler ?? (options.backgroundTasks === 'manual' ? false : undefined);

  // AB-10 — workflow versioning: compare a recovered run's stamped
  // `workflowVersion` (see `createRunWorkflow`'s `version` option) against the
  // currently-registered `runWorkflowVersion` and fire `onWorkflowVersionMismatch`
  // on drift. Read-only and non-blocking — see `runWorkflowVersion`'s JSDoc for
  // why this does NOT use Weft's own `WorkflowDefinition.version` recovery check.
  async function checkWorkflowVersionMismatch(info: WorkflowServicesResolverInfo): Promise<void> {
    if (options.runWorkflowVersion === undefined || !options.onWorkflowVersionMismatch) return;
    const cursor = await checkpointStore.loadCursor(info.workflowId);
    const storedVersion = cursor?.workflowVersion;
    if (storedVersion === undefined || storedVersion === options.runWorkflowVersion) return;
    options.onWorkflowVersionMismatch(
      new WorkflowVersionMismatchEvent(info.workflowId, storedVersion, options.runWorkflowVersion),
    );
  }

  async function resolveWorkflowServices(
    info: WorkflowServicesResolverInfo,
  ): Promise<WorkflowServicesResolution> {
    if (info.workflowType === DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE) {
      return resolveDurableHeartbeatTickServices(durableHeartbeatServicesStore, info);
    }

    await checkWorkflowVersionMismatch(info);

    if (options.resolveWorkflowServices) {
      return options.resolveWorkflowServices(info);
    }

    return {
      status: 'unavailable',
      reason: `run ${info.workflowId} has no configured workflow services resolver`,
    };
  }
  const workflows: Record<string, AnyWorkflowDefinition> = {
    agentRun: options.runWorkflow,
    durableHeartbeatTick: createDurableHeartbeatTickWorkflow(),
  };

  const engine = await Engine.create({
    storage: options.storage,
    recover: options.recover ?? true,
    // AB-178 — fenced per-workflow ownership, host-configurable rather than
    // unconditional. Defaults to `'none'` (today's behavior) because
    // `'workflow-lease'` has a reproduced weft 0.23.1 defect that breaks the
    // scheduler's same-engine suspend/resume preemption path — see
    // `CreateRunEngineOptions.ownership`'s JSDoc for the full defect and the
    // storage-capability requirement. A host that does not rely on that
    // preemption path, or that has verified it is unaffected, can opt in.
    ownership: options.ownership ?? 'none',
    ...(options.workflowClaimTtlMs !== undefined
      ? { workflowClaimTtl: options.workflowClaimTtlMs }
      : {}),
    ...(options.workflowClaimRenewIntervalMs !== undefined
      ? { workflowClaimRenewInterval: options.workflowClaimRenewIntervalMs }
      : {}),
    ...(options.backgroundTasks !== undefined ? { backgroundTasks: options.backgroundTasks } : {}),
    ...(startScheduler !== undefined ? { startScheduler } : {}),
    ...(options.schedulerPollIntervalMs !== undefined
      ? { schedulerPollIntervalMs: options.schedulerPollIntervalMs }
      : {}),
    resolveWorkflowServices,
    ...(options.onLog ? { onLog: options.onLog } : {}),
    ...(options.history ? { history: options.history } : {}),
    ...(options.checkpointSizeWarningThreshold !== undefined
      ? { checkpointSizeWarningThreshold: options.checkpointSizeWarningThreshold }
      : {}),
    ...(options.checkpointHistory !== undefined
      ? { checkpointHistory: options.checkpointHistory }
      : {}),
    ...(options.payloadSize ? { payloadSize: options.payloadSize } : {}),
    workflows,
    activities: {
      saveCursor: storageActivities.saveCursor,
      saveConversation: storageActivities.saveConversation,
      recordStep: storageActivities.recordStep,
    },
  });
  attachDurableHeartbeatServicesStore(engine, durableHeartbeatServicesStore);

  // Surface checkpoint-size warnings: a dispatched event nobody listens to is no
  // warning. The engine is an EventTarget; the subscription lives as long as the
  // engine (released on dispose).
  if (options.onCheckpointSizeWarning) {
    engine.addEventListener('checkpoint:size-warning', options.onCheckpointSizeWarning);
  }

  // Wire observability AFTER construction so the engine itself is the
  // `eventTarget`: root workflow spans then close on terminal lifecycle events
  // instead of accumulating until disposal. `addInterceptor` is the documented
  // idiom (see the weft observability example) and works on the created engine.
  const observability = options.observability
    ? wireObservability(engine, options.observability)
    : undefined;

  return { engine, checkpointStore, ...(observability ? { observability } : {}) };
}

/**
 * Build and attach the observability interceptor, returning the metrics handle
 * and a `dispose` the caller invokes before engine disposal. `eventTarget` is the
 * engine so spans close on terminal events; `@opentelemetry/api` absence makes
 * every span op a no-op.
 */
function wireObservability(
  engine: RegistryAgnosticEngine,
  observability: boolean | Omit<ObservabilityOptions, 'eventTarget'>,
): RunEngineObservability {
  const baseOptions = observability === true ? {} : observability;
  const { interceptor, metrics, dispose } = createObservabilityInterceptors({
    ...baseOptions,
    eventTarget: engine,
  });
  engine.addInterceptor(interceptor);
  return { metrics, dispose };
}

/**
 * Build a {@link CheckpointStore} over a `textValueStore` view of a raw
 * {@link Storage}. The view does NOT dispose the underlying backend on close —
 * the engine owns the backend's lifecycle.
 */
function createCheckpointStoreFromStorage(storage: Storage): CheckpointStore {
  return createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
}
