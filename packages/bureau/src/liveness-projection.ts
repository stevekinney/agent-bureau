import {
  type DeclaredWait,
  LIVENESS_POLICY_VERSION,
  type LivenessAssessment,
  type LivenessEvidenceEntry,
  type LivenessLeaseEvidence,
  type LivenessLifecycleStatus,
  type LivenessProgressState,
  type LivenessReachability,
  type LivenessSnapshot,
} from '@lostgradient/operative/liveness';
import type { EngineLeaseHealth } from '@lostgradient/weft';
import type { WeftClient } from '@lostgradient/weft/client';

/**
 * Weft's own `weft.tasks.diagnostics`/`weft.workers.diagnostics` server
 * operations, projected into Bureau's `weft-worker`/`weft-task`/
 * `weft-stream`/`weft-engine-lease` `LivenessSnapshot`s (AB-218/obs-05, AB-88
 * AC12). Every field is populated only from a value one of these accessors
 * actually returned; a field they did not report stays `undefined`, never
 * synthesized from adjacent evidence. This module never calls anything that
 * mutates lease or heartbeat state — it only reads `Engine.getLeaseHealth()`
 * and the two diagnostics operations.
 *
 * `Engine.getLeaseHealth()` is verified (against
 * `@lostgradient/weft@0.23.1`'s `dist/core/engine/index.d.ts`) as the
 * public, synchronous accessor Bureau's held `Engine` instance already
 * exposes on `RegistryAgnosticEngine` — never the internal
 * `LeaseManager`/`WorkerRegistry` modules. `weft.workers.diagnostics` and
 * `weft.tasks.diagnostics` are NOT re-exported from `@lostgradient/weft`'s
 * `.`/`./server`/`./client` entry points as named functions; they are
 * reachable only through `WeftClient.operations['weft.workers.diagnostics']`
 * / `WeftClient.operations['weft.tasks.diagnostics']` (a `LocalClient`
 * wrapping the same in-process `Engine`, or an `HttpClient`) — see
 * `client/interface.ts`'s own JSDoc: "server operations the ergonomic
 * surface does not curate (workers, task queues, task diagnostics, ...)".
 */

// ---------------------------------------------------------------------------
// Types derived structurally from `WeftClient`, since `@lostgradient/weft`
// does not re-export the underlying `GetWorkerDiagnosticsOutput`/
// `GetTaskDiagnosticsOutput` names from any public entry point.
// ---------------------------------------------------------------------------

export type WorkerDiagnosticsResult = Awaited<
  ReturnType<WeftClient['operations']['weft.workers.diagnostics']>
>;
export type TaskDiagnosticsResult = Awaited<
  ReturnType<WeftClient['operations']['weft.tasks.diagnostics']>
>;
type TaskDiagnosticsInput = Parameters<WeftClient['operations']['weft.tasks.diagnostics']>[0];
type TaskDiagnosticItem = TaskDiagnosticsResult['items'][number];

/**
 * The caller-supplied subset of `weft.tasks.diagnostics`'s input identifying
 * which task to read. `operationId` is required (not `weft.tasks.diagnostics`'s
 * own optional field) because `projectTaskLivenessSnapshot` projects exactly
 * one task's `weft-task` `LivenessSnapshot` and matches the returned `items`
 * against it — an omitted `operationId` would silently match nothing and
 * misreport a stale task as `'healthy'`.
 */
export type TaskDiagnosticsFilter = Pick<TaskDiagnosticsInput, 'workflowId' | 'queue'> & {
  readonly operationId: string;
};

/**
 * Weft's own defaults for `weft.tasks.diagnostics`'s threshold fields
 * (`DEFAULT_STALE_QUEUED_AFTER_MS`/`DEFAULT_STALE_HEARTBEAT_AFTER_MS`/
 * `DEFAULT_RETRY_STORM_MINIMUM_ATTEMPTS`/`DEFAULT_UNADOPTED_AFTER_MS`/
 * `DEFAULT_LIMIT` in `@lostgradient/weft@0.23.1`'s
 * `dist/server/operations/get-task-diagnostics.js`), mirrored verbatim
 * rather than invented: the client-generated `ClientOperationTypes` input
 * type requires every threshold explicitly (there is no way to omit a
 * field over this transport and let Weft's own server-side default apply),
 * so this module supplies exactly the values Weft itself would have used.
 */
const WEFT_TASK_DIAGNOSTICS_DEFAULTS = {
  staleQueuedAfterMs: 60_000,
  staleHeartbeatAfterMs: 60_000,
  retryStormMinimumAttempts: 3,
  includeExpectedDelayed: false,
  unadoptedAfterMs: 60_000,
  limit: 50,
} as const;

/**
 * Narrow, injectable view of Weft's public client and engine surfaces this
 * module reads. Deliberately not a whole `Engine`/`WeftClient` — the
 * testing plan requires test doubles, never a real Weft server; a caller
 * wires the real accessors in (e.g. `engine.getLeaseHealth.bind(engine)`,
 * `(workerId) => client.operations['weft.workers.diagnostics']({ workerId })`).
 */
export interface WeftLivenessSource {
  readonly getLeaseHealth: () => EngineLeaseHealth;
  readonly getWorkerDiagnostics: (workerId: string) => Promise<WorkerDiagnosticsResult>;
  /**
   * The real wiring for this accessor passes `buildTaskDiagnosticsInput(filter)`
   * to `client.operations['weft.tasks.diagnostics']` — this module supplies
   * only the filter; the caller merges in Weft's own default thresholds via
   * {@link buildTaskDiagnosticsInput} before calling the operation.
   */
  readonly getTaskDiagnostics: (input: TaskDiagnosticsFilter) => Promise<TaskDiagnosticsResult>;
}

/**
 * The caller-supplied envelope fields this module cannot itself know
 * (Bureau's own identity/ownership/attempt bookkeeping for the subject
 * being projected) — everything this module DOES compute (reachability,
 * progress, assessment, evidence, lease, heartbeat timestamps) is derived
 * exclusively from `WeftLivenessSource`.
 */
export interface LivenessSnapshotEnvelope {
  readonly id: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly startedAt: string;
  readonly revision: number;
  readonly lastTransitionAt: string;
  readonly ownership: 'independent' | 'parent-owned' | 'inline';
  readonly detached: boolean;
  readonly durability: 'process-local' | 'durable';
  readonly cancellable: boolean;
  /** Bureau's own attempt-fencing counter (AC8) — never parsed or hashed from a Weft token. */
  readonly attempt: number;
  /** Observer monotonic clock this projection is computed against. */
  readonly observedAt: number;
}

function baseFields(envelope: LivenessSnapshotEnvelope, status: LivenessLifecycleStatus) {
  return {
    id: envelope.id,
    owner: envelope.owner,
    parentId: envelope.parentId,
    startedAt: envelope.startedAt,
    revision: envelope.revision,
    status,
    lastTransitionAt: envelope.lastTransitionAt,
    // Declared single-projection permanently for this module's subjects,
    // per AB-88's standalone-run resolution — there is no privileged
    // variant here (no principal context flows into a Weft diagnostics read).
    projection: 'redacted' as const,
    ownership: envelope.ownership,
    detached: envelope.detached,
    durability: envelope.durability,
    cancellable: envelope.cancellable,
    attempt: envelope.attempt,
    observedAt: envelope.observedAt,
    missedPulseCount: 0,
    policyVersion: LIVENESS_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// weft-engine-lease
// ---------------------------------------------------------------------------

/**
 * Projects `Engine.getLeaseHealth()` into a `weft-engine-lease`
 * `LivenessSnapshot`. `epoch` is populated only when `getLeaseHealth()`
 * reports an active, confirmed holder record (`status: 'healthy'`) for THIS
 * process — a detached or deposed (`status: 'contested'`) engine's lease
 * evidence carries no fabricated epoch, per `getLeaseHealth`'s own
 * documented behavior of reporting confirmed loss without inventing
 * successor details. `lossReason`, when Weft's lease manager reports one, is
 * relayed verbatim in the evidence entry's `detail` — this module asserts no
 * competing determination of its own.
 *
 * The `LivenessLeaseEvidence.source` value `'weft-workflow-lease'` is the
 * closest of AB-88's three ratified values to `Engine.getLeaseHealth()`:
 * `EngineLeaseHealth`'s `mode: 'lease'` branch IS `LeaseManagerHealth`
 * (Weft's `LeaseManager`, the same ownership mechanism AB-88's decision text
 * names), which gates workflow execution ownership — distinct from a
 * per-activity lease and from the connected-worker registry.
 */
export function projectEngineLeaseSnapshot(
  source: Pick<WeftLivenessSource, 'getLeaseHealth'>,
  envelope: LivenessSnapshotEnvelope,
): LivenessSnapshot & { kind: 'weft-engine-lease' } {
  const health = source.getLeaseHealth();
  const evidence: LivenessEvidenceEntry[] = [];
  let lease: LivenessLeaseEvidence | undefined;
  let reachability: LivenessReachability;
  let progress: LivenessProgressState;
  let assessment: LivenessAssessment;

  if (health.mode === 'none' || health.status === 'no-lease') {
    // Lease ownership is disabled, or not yet acquired — not a breach, but
    // nothing to report evidence for either.
    reachability = 'unknown';
    progress = 'unknown';
    assessment = 'healthy';
  } else if (health.status === 'healthy') {
    lease = {
      holderId: health.holderId,
      expiresAt: health.expiresAt,
      epoch: health.fencingEpoch,
      source: 'weft-workflow-lease',
    };
    evidence.push({
      source: 'lease-renewal',
      at: health.lastRenewedAt,
      attempt: envelope.attempt,
      detail: health,
    });
    reachability = 'reachable';
    progress = 'progressing';
    assessment = 'healthy';
  } else {
    // status === 'contested': deposed or renewal-unconfirmable. No epoch —
    // this is exactly the "confirmed loss without inventing successor
    // details" case the acceptance criteria names. `EngineLeaseHealth`'s
    // sparsest contested shape (`{ mode: 'lease', status: 'contested',
    // holdsLease: false, lossReason: 'deposed' }`) carries no holder record
    // at all — no `holderId`/`expiresAt` to report either, so `lease` stays
    // `undefined` rather than fabricating placeholder identifiers.
    if ('holderId' in health) {
      lease = {
        holderId: health.holderId,
        expiresAt: health.expiresAt,
        source: 'weft-workflow-lease',
      };
    }
    evidence.push({
      source: 'lease-renewal',
      at: 'lastRenewedAt' in health ? health.lastRenewedAt : envelope.observedAt,
      attempt: envelope.attempt,
      detail: health,
    });
    // AC1's legal-combination rule: 'stalled' is legal only with 'reachable'
    // or 'late' — with 'unreachable' the assessment collapses to
    // 'unreachable' and progress cannot itself be 'stalled'.
    reachability = 'unreachable';
    progress = 'unknown';
    assessment = 'unreachable';
  }

  return {
    ...baseFields(envelope, 'running'),
    kind: 'weft-engine-lease',
    reachability,
    progress,
    assessment,
    lease,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// weft-worker / weft-stream (AC: weft-stream reuses the weft-worker row's
// exact values, since Weft exposes no separate stream-diagnostics accessor)
// ---------------------------------------------------------------------------

interface WorkerLivenessFields {
  readonly reachability: LivenessReachability;
  readonly progress: LivenessProgressState;
  readonly assessment: LivenessAssessment;
  readonly lastHeartbeatAt?: number;
  readonly evidence: readonly LivenessEvidenceEntry[];
}

function computeWorkerLivenessFields(
  worker: WorkerDiagnosticsResult['worker'],
  envelope: LivenessSnapshotEnvelope,
): WorkerLivenessFields {
  if (worker === null) {
    // Weft explicitly reported no connected worker record for this id — a
    // concrete fact from the diagnostics operation, not an inference.
    return {
      reachability: 'unreachable',
      progress: 'unknown',
      assessment: 'unreachable',
      evidence: [],
    };
  }

  const lastHeartbeatAt = envelope.observedAt - worker.instance.heartbeatAgeMs;
  const evidence: LivenessEvidenceEntry[] = [
    {
      source: 'worker-session-heartbeat',
      at: lastHeartbeatAt,
      attempt: envelope.attempt,
      detail: worker.instance,
    },
  ];

  if (worker.instance.health === 'active') {
    return {
      reachability: 'reachable',
      progress: 'progressing',
      assessment: 'healthy',
      lastHeartbeatAt,
      evidence,
    };
  }
  if (worker.instance.health === 'draining') {
    // Still connected and heartbeating, intentionally not accepting new
    // work — not a stall.
    return {
      reachability: 'reachable',
      progress: 'idle',
      assessment: 'healthy',
      lastHeartbeatAt,
      evidence,
    };
  }
  // 'drained' — fully wound down / disconnected.
  return {
    reachability: 'unreachable',
    progress: 'unknown',
    assessment: 'unreachable',
    lastHeartbeatAt,
    evidence,
  };
}

/**
 * Projects `weft.workers.diagnostics` into a `weft-worker` `LivenessSnapshot`.
 * `lastHeartbeatAt` is populated only when Weft returned a worker record
 * (`worker !== null`); it is never synthesized when the worker is unknown.
 */
export async function projectWorkerLivenessSnapshot(
  source: Pick<WeftLivenessSource, 'getWorkerDiagnostics'>,
  workerId: string,
  envelope: LivenessSnapshotEnvelope,
): Promise<LivenessSnapshot & { kind: 'weft-worker' }> {
  const { worker } = await source.getWorkerDiagnostics(workerId);
  const fields = computeWorkerLivenessFields(worker, envelope);
  return {
    ...baseFields(envelope, 'running'),
    kind: 'weft-worker',
    ...fields,
  };
}

/**
 * Projects the same worker-level heartbeat evidence a stream rides on into a
 * `weft-stream` `LivenessSnapshot` (AB-218's own AC: "`weft-stream` reuses
 * the `weft-worker` row's exact values ... because Weft exposes no separate
 * stream-diagnostics accessor"). `workerId` is the worker the stream is
 * attached to.
 */
export async function projectStreamLivenessSnapshot(
  source: Pick<WeftLivenessSource, 'getWorkerDiagnostics'>,
  workerId: string,
  envelope: LivenessSnapshotEnvelope,
): Promise<LivenessSnapshot & { kind: 'weft-stream' }> {
  const { worker } = await source.getWorkerDiagnostics(workerId);
  const fields = computeWorkerLivenessFields(worker, envelope);
  return {
    ...baseFields(envelope, 'running'),
    kind: 'weft-stream',
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// weft-task
// ---------------------------------------------------------------------------

interface TaskLivenessFields {
  readonly status: LivenessLifecycleStatus;
  readonly reachability: LivenessReachability;
  readonly progress: LivenessProgressState;
  readonly assessment: LivenessAssessment;
  readonly lastHeartbeatAt?: number;
  readonly deadline?: number;
  readonly declaredWait?: DeclaredWait;
  readonly evidence: readonly LivenessEvidenceEntry[];
}

/**
 * Maps one `weft.tasks.diagnostics` item to this module's liveness fields.
 * Weft's diagnostics operation only emits an item when it already
 * classified an anomaly (AC's own framing: "a single `getTaskDiagnostics`
 * reading with `heartbeatAgeMs` past Weft's own visibility timeout is
 * sufficient, since Weft's diagnostics operation has already aggregated
 * staleness — there is no local pulse-counting to threshold further"), so
 * this is a direct, conservative relay of Weft's own `kind`/`state`
 * classification — never a second, independently-computed threshold.
 *
 * The AC names the `state: 'inflight'` collapse explicitly
 * (`'stale-inflight'` → `'alive-but-stalled'`); the remaining `kind` values
 * are mapped with the same no-competing-inference discipline: `evidence`,
 * `queue`/`retry`-storm anomalies conservatively read as `'alive-but-stalled'`
 * (work is happening, but Weft itself flagged it as anomalous), a terminal
 * ledger state (`'dead-lettered'`/`'unadopted-terminal'`) as `'terminal'`,
 * and an expected future dispatch (`'delayed'`) or capacity pressure
 * (`'all-workers-at-capacity'`) as `'legitimately-waiting'` with a
 * `'queue-capacity'` declared wait.
 */
function computeTaskLivenessFields(
  item: TaskDiagnosticItem | undefined,
  envelope: LivenessSnapshotEnvelope,
): TaskLivenessFields {
  if (item === undefined) {
    // No anomaly reported for this task — Weft's own diagnostics operation
    // says so; this is a relayed fact, not an inference.
    return {
      status: 'running',
      reachability: 'reachable',
      progress: 'progressing',
      assessment: 'healthy',
      evidence: [],
    };
  }

  const heartbeatAgeMs = 'heartbeatAgeMs' in item ? item.heartbeatAgeMs : undefined;
  const lastHeartbeatAt =
    heartbeatAgeMs === undefined ? undefined : envelope.observedAt - heartbeatAgeMs;
  // Only push a 'task-attempt-heartbeat' entry when Weft's own diagnostic
  // item actually reported one (heartbeatAgeMs present). A 'delayed',
  // 'stuck-queued', 'dead-lettered', or 'unadopted-terminal' item — and a
  // partial 'stale-inflight'/'retry-storm' record missing heartbeatAgeMs —
  // never had a heartbeat to report, so no evidence entry is fabricated for
  // one; the mapped facts already live in status/assessment/declaredWait/deadline.
  const evidence: LivenessEvidenceEntry[] =
    lastHeartbeatAt === undefined
      ? []
      : [
          {
            source: 'task-attempt-heartbeat',
            at: lastHeartbeatAt,
            attempt: envelope.attempt,
            detail: item,
          },
        ];

  switch (item.kind) {
    case 'stale-inflight':
    case 'retry-storm':
      return {
        status: 'running',
        reachability: 'late',
        progress: 'stalled',
        assessment: 'alive-but-stalled',
        lastHeartbeatAt,
        evidence,
      };
    case 'stuck-queued':
      return {
        status: 'queued',
        reachability: 'late',
        progress: 'stalled',
        assessment: 'alive-but-stalled',
        lastHeartbeatAt,
        evidence,
      };
    case 'dead-lettered':
    case 'unadopted-terminal':
      return {
        status: 'terminal',
        reachability: 'not-applicable',
        progress: 'not-applicable',
        assessment: 'terminal',
        lastHeartbeatAt,
        evidence,
      };
    case 'delayed':
    case 'all-workers-at-capacity':
      return {
        status: 'waiting',
        reachability: 'unknown',
        progress: 'idle',
        assessment: 'legitimately-waiting',
        lastHeartbeatAt,
        deadline: item.kind === 'delayed' ? item.availableAt : undefined,
        declaredWait: {
          reason: 'queue-capacity',
          startedAt: envelope.observedAt,
          dependency: item.kind === 'delayed' ? item.queue : undefined,
          deadline: item.kind === 'delayed' ? item.availableAt : undefined,
          wakeCondition:
            item.kind === 'delayed'
              ? 'scheduled dispatch time reached'
              : 'worker capacity available',
        },
        evidence,
      };
  }
}

/**
 * Projects `weft.tasks.diagnostics`, filtered to one task, into a
 * `weft-task` `LivenessSnapshot`. Every threshold this module passes to the
 * operation mirrors Weft's own server-side default (see
 * `WEFT_TASK_DIAGNOSTICS_DEFAULTS`) — nothing tighter or looser is invented
 * locally.
 */
export async function projectTaskLivenessSnapshot(
  source: Pick<WeftLivenessSource, 'getTaskDiagnostics'>,
  filter: TaskDiagnosticsFilter,
  envelope: LivenessSnapshotEnvelope,
): Promise<LivenessSnapshot & { kind: 'weft-task' }> {
  const { items } = await source.getTaskDiagnostics(filter);
  const item = items.find(
    (candidate) => 'operationId' in candidate && candidate.operationId === filter.operationId,
  );
  const fields = computeTaskLivenessFields(item, envelope);
  return {
    ...baseFields(envelope, fields.status),
    kind: 'weft-task',
    ...fields,
  };
}

/** Convenience: the full `weft.tasks.diagnostics` input, filter plus Weft's own defaults. */
export function buildTaskDiagnosticsInput(filter: TaskDiagnosticsFilter): TaskDiagnosticsInput {
  return { ...WEFT_TASK_DIAGNOSTICS_DEFAULTS, ...filter };
}
