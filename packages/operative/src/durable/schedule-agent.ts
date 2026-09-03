import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { parseDuration, ScheduleHandle } from '@lostgradient/weft';
import type { RuntimeServices } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

import type { ClosedFunction } from '../closed-acknowledgement';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import { ScheduleCancelledEvent, SchedulePausedEvent, ScheduleResumedEvent } from '../events';
import type { EventDispatcher } from '../run-step';
import type { CleanupAcknowledgement, ClosedOptions } from '../types';

/**
 * The overlap policies Agent Bureau exposes on its three schedule-creation
 * paths (`Bureau.createSchedule`, `createAgentSchedule`/`AgentScheduleOptions`,
 * and the `scheduleSelf` tool). Weft's own {@link ScheduleOverlapPolicy} also
 * includes `'queue'` and `'cancel-running'`; AB-41's decision record names
 * those intentionally hidden, not a gap to close, so Agent Bureau narrows to
 * this subset everywhere a caller supplies an overlap policy.
 */
export type AgentScheduleOverlapPolicy = Extract<ScheduleOverlapPolicy, 'skip' | 'allow'>;

const SUPPORTED_OVERLAP_POLICIES: ReadonlySet<string> = new Set<AgentScheduleOverlapPolicy>([
  'skip',
  'allow',
]);

/**
 * The input injected into the `agentRun` workflow when started by a durable
 * schedule. Carries the agent name, the prompt, and the optional session that
 * the schedule fires into (present → recurring conversation, absent → fresh
 * session per fire).
 *
 * IMPORTANT: this must be a plain, JSON-cloneable value because Weft
 * checkpoints it alongside the schedule definition.
 */
export interface ScheduledAgentRunInput {
  /** The agent name to dispatch to. Resolved by the bureau at fire time. */
  agentName: string;
  /** The prompt / message injected into the agent run for each fire. */
  input: string;
  /**
   * Optional session to append each fire's run into. When present, each
   * scheduled run CONTINUES that session's conversation, accumulating context
   * across fires ("daily digest that remembers yesterday"). When absent, each
   * fire starts a FRESH standalone session.
   */
  sessionId?: string;
  /**
   * Stable schedule id that launched this fire. Persisted in the input because
   * Weft does not include `info.schedule` when a scheduled fire is recovered
   * through `recoverAll()`, but stateless fires need the schedule id to rebuild
   * the same per-fire session id after a crash.
   */
  scheduleId?: string;
}

/**
 * Narrow an `unknown` durable input to a {@link ScheduledAgentRunInput}. Used by
 * the bureau's run-services resolver when `info.schedule !== undefined` already
 * proves a native scheduled fire — this guard only confirms the payload is a
 * well-formed `{ agentName, input, sessionId? }` before it is trusted. It does
 * NOT need to discriminate against {@link AgentRunWorkflowInput}; the schedule
 * origin is established by weft's `info.schedule`, not by the payload shape.
 */
export function isScheduledAgentRunInput(value: unknown): value is ScheduledAgentRunInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['agentName'] !== 'string' || typeof candidate['input'] !== 'string') {
    return false;
  }
  const sessionId = candidate['sessionId'];
  if (sessionId !== undefined && typeof sessionId !== 'string') return false;
  const scheduleId = candidate['scheduleId'];
  if (scheduleId !== undefined && typeof scheduleId !== 'string') return false;
  return true;
}

/**
 * Options for `createAgentSchedule`. Maps the bureau scheduling surface
 * (`spec`, `session`, `overlap`) onto the underlying Weft `engine.schedule`
 * call.
 */
export interface CreateAgentScheduleOptions {
  /**
   * The Weft engine to register the schedule on. Must be the same engine the
   * bureau built over its `.persistence()` store. Typed as {@link SchedulingEngine}
   * — the narrow scheduling-only surface (`schedule`, `getSchedule`,
   * `listSchedules`, `pauseSchedule`, `resumeSchedule`, `cancelSchedule`) —
   * rather than the full `RegistryAgnosticEngine`, since this module never
   * needs anything else the full engine exposes (workflow start/signal/query,
   * recovery, disposal, …); widening the parameter to the full engine type
   * would force a cast back down at every call site instead of accepting
   * exactly the surface actually used.
   */
  engine: SchedulingEngine;
  /**
   * The name of the registered `agentRun` workflow type (always `'agentRun'` in
   * the current architecture, but injectable for testing).
   * @default 'agentRun'
   */
  workflowType?: string;
  /** The agent name to schedule (maps to `ScheduledAgentRunInput.agentName`). */
  agentName: string;
  /**
   * The recurrence specification. Exactly one of `cron` or `every` must be
   * supplied.
   *
   * @example { cron: '0 9 * * *' }   // daily at 9am
   * @example { every: '6h' }           // every 6 hours
   */
  spec: ScheduleSpec;
  /**
   * The prompt injected on each scheduled fire (maps to
   * `ScheduledAgentRunInput.input`).
   */
  input: string;
  /** Human-readable operator description stored with the schedule. */
  description?: string;
  /**
   * Optional session id. When supplied, each fire APPENDS a run to this session
   * → the agent accumulates context across fires (the "recurring conversation"
   * pattern). When absent, each fire starts a standalone session with no shared
   * history.
   */
  session?: string;
  /**
   * How to handle a tick that fires while the previous run is still in
   * progress. Defaults to `'skip'` (drop the new run silently). Agent Bureau
   * exposes only `'skip' | 'allow'` — see {@link AgentScheduleOverlapPolicy}.
   */
  overlap?: AgentScheduleOverlapPolicy;
  /**
   * Optional stable id for this schedule (used by `getSchedule`/`pauseSchedule`
   * etc.). Defaults to an id minted through `options.runtime` (AB-92/AB-253).
   */
  id?: string;
  /**
   * When true with a stable `id`, an existing compatible schedule is treated as
   * success. This is for durable replay of effectful schedule registration.
   */
  idempotent?: boolean;
  /**
   * Optional event dispatcher. When supplied, the returned handle's
   * `pause`/`resume`/`cancel` each dispatch `SchedulePausedEvent`/
   * `ScheduleResumedEvent`/`ScheduleCancelledEvent` (AB-223) exactly once per
   * successful call, after the underlying engine call settles. Omitted
   * entirely for a caller with no event surface — this module never
   * manufactures one.
   */
  emitter?: EventDispatcher;
  /**
   * The AB-92/AB-252/AB-253 injectable runtime-service seam. Resolved
   * exactly once — omitted, a schedule id (when `id` is not supplied) is
   * minted via the real globals through `createDefaultRuntimeServices()`;
   * a test composes its own deterministic instance with
   * `createManualRuntimeServices()` for a fully deterministic id.
   */
  runtime?: RuntimeServices;
}

/**
 * Manage the lifecycle of a durable agent schedule returned by
 * {@link createAgentSchedule}.
 */
export interface AgentScheduleHandle {
  /** The stable id assigned to this schedule by Weft. */
  readonly id: string;
  /** Pause the schedule (it will not fire until resumed). */
  pause(): Promise<void>;
  /** Resume a previously paused schedule. */
  resume(): Promise<void>;
  /** Cancel the schedule permanently (terminal, cannot be undone). */
  cancel(): Promise<void>;
  /** Read the current {@link ScheduleSummary} for this schedule. */
  describe(): Promise<ScheduleSummary>;

  /**
   * Cleanup acknowledgement for the schedule DEFINITION itself (AB-37/AB-210)
   * — mirrors `cancel()`'s own terminal-state semantics rather than tracking
   * any individual fire. Resolves once no future fire can start: promptly
   * after this handle's own `cancel()` settles, and NEVER spontaneously for
   * a schedule that has not been cancelled — an active schedule's `closed()`
   * stays pending even after a fire completes, until THIS handle's own
   * `cancel()` is called and settles. (A Bureau shutdown that cancels the
   * schedule through some other route does not resolve this promise; that
   * wiring, if any, is Bureau's to add.)
   *
   * Never waits on any separately-tracked in-flight fire: a fire dispatched
   * before `cancel()` and still running is an ordinary run, reachable and
   * awaitable through its own `closed()` (AB-204), not through this handle.
   *
   * A `cancel()` call that itself rejects (the underlying engine call
   * throws) resolves this as `{ status: 'failed', error }` rather than
   * hanging forever — the failed cancellation attempt is a genuine, observed
   * problem, not silently swallowed into "stays pending".
   */
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
}

/**
 * Engine-level scheduling surface used by {@link AgentScheduler}.
 *
 * Extracted so tests can provide a partial stub without implementing the full
 * `RegistryAgnosticEngine` interface.
 */
export interface SchedulingEngine {
  schedule(
    type: string,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ScheduleHandle>;
  getSchedule(scheduleId: string): Promise<ScheduleSummary | null>;
  listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>>;
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
  cancelSchedule(scheduleId: string): Promise<void>;
}

/**
 * The bureau-level scheduling surface. Provides `schedule`, `getSchedule`,
 * `listSchedules`, `pauseSchedule`, and `cancelSchedule` — thin wrappers over
 * the Weft engine that surface agent-oriented semantics.
 *
 * Returned by {@link createAgentScheduler} and consumed by the bureau (Phase E)
 * or used directly in tests.
 */
export interface AgentScheduler {
  /**
   * Register a recurring durable schedule that fires `agentName` on the given
   * `spec`. Returns an {@link AgentScheduleHandle} for lifecycle management.
   *
   * Session semantics (per architecture.md § Scheduling):
   * - `session` supplied → each fire APPENDS a run to that session (recurring
   *   conversation, accumulates context across fires).
   * - `session` absent → each fire starts a STANDALONE fresh session (stateless
   *   cron job).
   */
  schedule(agentName: string, options: AgentScheduleOptions): Promise<AgentScheduleHandle>;
  /**
   * Get the current {@link ScheduleSummary} for a schedule id. Returns `null`
   * if the schedule does not exist.
   */
  getSchedule(scheduleId: string): Promise<ScheduleSummary | null>;
  /**
   * List all agent schedules, with optional filtering by status / workflow type /
   * pagination. Returns a paginated result of {@link ScheduleSummary} entries.
   */
  listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>>;
  /** Pause a schedule by id (skips upcoming fires until resumed). */
  pauseSchedule(scheduleId: string): Promise<void>;
  /** Cancel a schedule by id (permanent). */
  cancelSchedule(scheduleId: string): Promise<void>;
}

/**
 * Options for `AgentScheduler.schedule(agentName, options)`. Does NOT include
 * `agentName` or `engine` — those are supplied at scheduler construction.
 */
export interface AgentScheduleOptions {
  /** Recurrence specification. Exactly one of `cron` or `every`. */
  spec: ScheduleSpec;
  /** Prompt injected into each scheduled run. */
  input: string;
  /** Human-readable operator description stored with the schedule. */
  description?: string;
  /**
   * Optional session id. Present → recurring conversation; absent → fresh session
   * per fire. See architecture.md § External schedule (caller-chosen session
   * relationship).
   */
  session?: string;
  /**
   * Overlap policy. Defaults to `'skip'`. Agent Bureau exposes only
   * `'skip' | 'allow'` — see {@link AgentScheduleOverlapPolicy}.
   */
  overlap?: AgentScheduleOverlapPolicy;
  /** Optional stable schedule id (defaults to Weft-assigned uuid). */
  id?: string;
  /**
   * When true with a stable `id`, an existing compatible schedule is treated as
   * success. Used by `scheduleSelf` during durable step replay.
   */
  idempotent?: boolean;
}

/**
 * Thrown by {@link createAgentSchedule} when a schedule definition is internally
 * incoherent (a blank recurring session id, or `overlap: 'allow'` combined with a
 * recurring session). Validating here — the single registration chokepoint that
 * `Bureau.createSchedule`, `AgentScheduler.schedule`, and the `scheduleSelf` tool
 * all route through — protects every caller, not just the bureau HTTP surface.
 * The bureau maps this to a `BAD_REQUEST` (HTTP 400).
 */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

/**
 * Builds `AgentScheduleHandle.closed()`, shared by both handle-construction
 * sites below (`scheduleHandleFromEngine` and `createAgentSchedule`'s own
 * return). AB-210: resolves once THIS handle's own `cancel()` call
 * completes — a schedule's `closed()` has no independent success path of
 * its own (unlike a run, which settles whether or not anyone requests
 * cancellation), so the shared helper's `not-required` fast path never
 * applies here and `disqualifiesFastPath` is unconditionally `true`. Reuses
 * `createClosedAcknowledgement` (AB-37/AB-204's shared vocabulary) purely
 * for its memoization and per-call `signal` handling — the acceptance
 * criterion that `closed()` never resolves spontaneously for a schedule
 * that has not been cancelled falls out of `cancelled` never settling on
 * its own.
 */
function createScheduleClosed(cancelled: Promise<void>): ClosedFunction {
  return createClosedAcknowledgement({
    result: cancelled,
    disqualifiesFastPath: () => true,
    hasInFlightWork: () => false,
    resolveOutcome: () => Promise.resolve({ status: 'completed' }),
  });
}

function scheduleHandleFromEngine(
  engine: SchedulingEngine,
  scheduleId: string,
  emitter?: EventDispatcher,
): AgentScheduleHandle {
  let resolveCancelled!: () => void;
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<void>((resolve, reject) => {
    resolveCancelled = resolve;
    rejectCancelled = reject;
  });
  return {
    id: scheduleId,
    async pause() {
      await engine.pauseSchedule(scheduleId);
      emitter?.dispatch(new SchedulePausedEvent(scheduleId));
    },
    async resume() {
      await engine.resumeSchedule(scheduleId);
      emitter?.dispatch(new ScheduleResumedEvent(scheduleId));
    },
    async cancel() {
      try {
        await engine.cancelSchedule(scheduleId);
      } catch (error) {
        // A failed cancellation attempt is a genuine, observed problem for
        // `closed()` too — reject `cancelled` so `createClosedAcknowledgement`
        // classifies it `{ status: 'failed', error }` instead of hanging
        // forever (a rejected `cancel()` here still propagates unchanged).
        rejectCancelled(error);
        throw error;
      }
      emitter?.dispatch(new ScheduleCancelledEvent(scheduleId));
      resolveCancelled();
    },
    async describe(): Promise<ScheduleSummary> {
      const schedule = await engine.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error(`Schedule ${scheduleId} no longer exists.`);
      }
      return schedule;
    },
    closed: createScheduleClosed(cancelled),
  };
}

/**
 * Reject an overlap policy Agent Bureau does not expose (`'queue'` /
 * `'cancel-running'`) before any Weft-side `engine.schedule()` call. The
 * `overlap` fields on {@link CreateAgentScheduleOptions} and
 * {@link AgentScheduleOptions} are already typed
 * {@link AgentScheduleOverlapPolicy} (`'skip' | 'allow'`), so a well-typed
 * caller cannot construct one of the hidden values — but the `scheduleSelf`
 * tool's Zod boundary and any caller coercing an untyped value past the
 * compiler still can, so this validates the value actually supplied at
 * runtime, not just its declared type.
 *
 * @throws {InvalidScheduleError} when `overlap` is defined and is not
 * `'skip'` or `'allow'`.
 */
function assertSupportedOverlapPolicy(
  overlap: string | undefined,
): asserts overlap is AgentScheduleOverlapPolicy | undefined {
  if (overlap !== undefined && !SUPPORTED_OVERLAP_POLICIES.has(overlap)) {
    throw new InvalidScheduleError(
      `overlap policy '${overlap}' is not supported by Agent Bureau; only 'skip' and 'allow' ` +
        "are exposed ('queue' and 'cancel-running' are intentionally hidden)",
    );
  }
}

function assertCompatibleAgentSchedule(
  schedule: ScheduleSummary,
  scheduleId: string,
  workflowType: string,
  spec: ScheduleSpec,
  overlap: ScheduleOverlapPolicy | undefined,
  description: string | undefined,
): void {
  if (schedule.status === 'cancelled') {
    throw new Error(`Schedule ${scheduleId} already exists but is cancelled.`);
  }

  if (schedule.workflowType !== workflowType) {
    throw new Error(
      `Schedule ${scheduleId} already exists for workflow ${schedule.workflowType}; expected ${workflowType}.`,
    );
  }

  const expectedOverlap = overlap ?? 'skip';
  if (schedule.overlap !== expectedOverlap) {
    throw new Error(
      `Schedule ${scheduleId} already exists with overlap ${schedule.overlap}; expected ${expectedOverlap}.`,
    );
  }

  if (schedule.description !== description) {
    throw new Error(`Schedule ${scheduleId} already exists with a different description.`);
  }

  if ('cron' in spec) {
    if (schedule.cronExpression !== spec.cron) {
      throw new Error(`Schedule ${scheduleId} already exists with a different cron spec.`);
    }
    return;
  }

  if (schedule.intervalMs !== parseDuration(spec.every)) {
    throw new Error(`Schedule ${scheduleId} already exists with a different interval spec.`);
  }
}

/**
 * Register a single recurring durable agent schedule against the given Weft
 * engine. Called by `AgentScheduler.schedule(...)` and (in production) the
 * `scheduleSelf` tool.
 *
 * Each fire starts the registered `agentRun` workflow with a
 * {@link ScheduledAgentRunInput} (`{ agentName, input, sessionId? }`). Weft mints
 * a fresh per-fire `workflowId` and passes this input through unchanged; the
 * bureau's run-services resolver discriminates the fire by `info.schedule`, then
 * builds fresh run deps from the input (the workflow body derives its `runId`
 * from `ctx.workflowId`, not from this input). See #109.
 *
 * Session semantics: `session` present → each fire continues that session's
 * conversation (recurring); absent → each fire is a fresh standalone session.
 *
 * @throws {InvalidScheduleError} when `session` or `id` is blank, or
 * `overlap: 'allow'` is combined with a recurring `session` (a recurring
 * conversation is sequential, so overlapping fires would interleave turns and
 * race the session write-back), or an `overlap` value outside
 * {@link AgentScheduleOverlapPolicy} reaches this function at runtime.
 */
export async function createAgentSchedule(
  options: CreateAgentScheduleOptions,
): Promise<AgentScheduleHandle> {
  const { engine, agentName, spec, input, description, session, overlap, id, idempotent, emitter } =
    options;
  const workflowType = options.workflowType ?? 'agentRun';
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  assertSupportedOverlapPolicy(overlap);
  if (session !== undefined && session.trim().length === 0) {
    throw new InvalidScheduleError('schedule session must be a non-empty string');
  }
  if (id !== undefined && id.trim().length === 0) {
    throw new InvalidScheduleError('schedule id must be a non-empty string');
  }
  if (session !== undefined && overlap === 'allow') {
    throw new InvalidScheduleError(
      "overlap 'allow' is incompatible with a recurring session (fires must serialize)",
    );
  }
  const scheduleId = id?.trim() ?? runtime.identifiers.next('schedule');

  // Trim the session id so a padded value ('  digest  ') persists under the same
  // key the caller means, matching `createRunFromRequest`'s `sessionId.trim()`
  // (review: cursor). The blank check above already rejected a whitespace-only id.
  const scheduledInput: ScheduledAgentRunInput = {
    agentName,
    input,
    scheduleId,
    ...(session !== undefined ? { sessionId: session.trim() } : {}),
  };

  const scheduleOptions: ScheduleOptions = {
    ...(description !== undefined ? { description } : {}),
    ...(overlap !== undefined ? { overlap } : {}),
    id: scheduleId,
  };

  if (id !== undefined && idempotent === true) {
    const existingSchedule = await engine.getSchedule(scheduleId);
    if (existingSchedule) {
      assertCompatibleAgentSchedule(
        existingSchedule,
        scheduleId,
        workflowType,
        spec,
        overlap,
        description,
      );
      return scheduleHandleFromEngine(engine, scheduleId, emitter);
    }
  }

  let handle: ScheduleHandle;
  try {
    handle = await engine.schedule(workflowType, scheduledInput, spec, scheduleOptions);
  } catch (error) {
    if (id !== undefined && idempotent === true) {
      const existingSchedule = await engine.getSchedule(scheduleId);
      if (existingSchedule) {
        assertCompatibleAgentSchedule(
          existingSchedule,
          scheduleId,
          workflowType,
          spec,
          overlap,
          description,
        );
        return scheduleHandleFromEngine(engine, scheduleId, emitter);
      }
    }
    throw error;
  }

  let resolveCancelled!: () => void;
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<void>((resolve, reject) => {
    resolveCancelled = resolve;
    rejectCancelled = reject;
  });

  return {
    id: handle.id,
    async pause() {
      await handle.pause();
      emitter?.dispatch(new SchedulePausedEvent(handle.id));
    },
    async resume() {
      await handle.resume();
      emitter?.dispatch(new ScheduleResumedEvent(handle.id));
    },
    async cancel() {
      try {
        await handle.cancel();
      } catch (error) {
        // Same reasoning as `scheduleHandleFromEngine`'s `cancel()`: a
        // failed cancellation attempt rejects `cancelled` so `closed()`
        // classifies it `{ status: 'failed', error }` rather than hanging.
        rejectCancelled(error);
        throw error;
      }
      emitter?.dispatch(new ScheduleCancelledEvent(handle.id));
      resolveCancelled();
    },
    describe: () => handle.describe(),
    closed: createScheduleClosed(cancelled),
  };
}

/**
 * Creates an {@link AgentScheduler} bound to the given engine and workflow type.
 *
 * The scheduler exposes the full scheduling surface needed by the bureau:
 * `schedule`, `getSchedule`, `listSchedules`, `pauseSchedule`, `cancelSchedule`.
 * It is a thin, bureau-oriented façade over the Weft engine — no new primitives,
 * no new deps.
 *
 * @example (bureau Phase E usage)
 * ```ts
 * const scheduler = createAgentScheduler({ engine });
 * const handle = await scheduler.schedule('researcher', {
 *   spec: { cron: '0 9 * * *' },
 *   input: 'Summarize overnight activity',
 *   session: 'daily-digest',
 *   overlap: 'skip',
 * });
 * await handle.pause();
 * ```
 */
export function createAgentScheduler(options: {
  engine: SchedulingEngine;
  workflowType?: string;
  /**
   * Optional event dispatcher bound at construction. Threaded into every
   * `createAgentSchedule` call this scheduler makes, so every handle it
   * returns dispatches `SchedulePausedEvent`/`ScheduleResumedEvent`/
   * `ScheduleCancelledEvent` (AB-223) from `pause`/`resume`/`cancel`.
   */
  emitter?: EventDispatcher;
}): AgentScheduler {
  const { engine, emitter } = options;
  const workflowType = options.workflowType ?? 'agentRun';

  return {
    async schedule(
      agentName: string,
      scheduleOptions: AgentScheduleOptions,
    ): Promise<AgentScheduleHandle> {
      return createAgentSchedule({
        engine,
        workflowType,
        agentName,
        emitter,
        ...scheduleOptions,
      });
    },

    getSchedule(scheduleId: string): Promise<ScheduleSummary | null> {
      return engine.getSchedule(scheduleId);
    },

    listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
      return engine.listSchedules(filter);
    },

    pauseSchedule(scheduleId: string): Promise<void> {
      return engine.pauseSchedule(scheduleId);
    },

    cancelSchedule(scheduleId: string): Promise<void> {
      return engine.cancelSchedule(scheduleId);
    },
  };
}
