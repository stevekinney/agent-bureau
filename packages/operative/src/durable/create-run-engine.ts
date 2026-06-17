import type {
  AnyWorkflowDefinition,
  CheckpointSizeWarningEvent,
  HistoryPolicy,
  PayloadSizePolicy,
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

import type { CheckpointStore } from './checkpoint-store';
import { createCheckpointStore } from './checkpoint-store';
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
 * A durable run engine, widened over its workflow/activity type parameters.
 *
 * `Engine`'s generics are invariant, so the precisely-typed engine
 * `Engine.create` returns is not assignable to the bare `Engine` default. The
 * durable run layer only ever calls `engine.start(name, input)` and disposal —
 * it never inspects the registered workflow/activity types — so widening here is
 * safe and matches gateway's `Toolbox<any>` convention for invariant generics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Engine generics are invariant; the run layer never inspects the type parameters.
export type AnyRunEngine = Engine<any, any>;

/**
 * The durable run engine plus the checkpoint store it was built with, so callers
 * can read/write checkpoints through the same view the activities use.
 */
export interface RunEngine {
  engine: AnyRunEngine;
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
 * History/checkpoint guardrails ({@link CreateRunEngineOptions.history},
 * `checkpointSizeWarningThreshold`, `checkpointHistory`, `payloadSize`) are
 * threaded into the engine; a `history.maxEvents` breach surfaces as a
 * `timed-out` terminal with `terminationReason: 'history-circuit-breaker'`, which
 * the active-run adapter classifies as `error` (not a deadline timeout).
 */
export async function createRunEngine(options: CreateRunEngineOptions): Promise<RunEngine> {
  const checkpointStore =
    options.checkpointStore ?? createCheckpointStoreFromStorage(options.storage);
  const storageActivities = createStorageActivities(checkpointStore);

  const engine = await Engine.create({
    storage: options.storage,
    recover: options.recover ?? true,
    resolveWorkflowServices: options.resolveWorkflowServices,
    ...(options.onLog ? { onLog: options.onLog } : {}),
    ...(options.history ? { history: options.history } : {}),
    ...(options.checkpointSizeWarningThreshold !== undefined
      ? { checkpointSizeWarningThreshold: options.checkpointSizeWarningThreshold }
      : {}),
    ...(options.checkpointHistory !== undefined
      ? { checkpointHistory: options.checkpointHistory }
      : {}),
    ...(options.payloadSize ? { payloadSize: options.payloadSize } : {}),
    workflows: { agentRun: options.runWorkflow },
    activities: {
      saveCursor: storageActivities.saveCursor,
      saveConversation: storageActivities.saveConversation,
      recordStep: storageActivities.recordStep,
    },
  });

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
  engine: AnyRunEngine,
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
