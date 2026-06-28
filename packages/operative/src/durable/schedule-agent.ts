import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { parseDuration, ScheduleHandle } from '@lostgradient/weft';

import type { AnyRunEngine } from './create-run-engine';

type ScheduleIdCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
};

function createScheduleId(): string {
  const crypto = (globalThis as { crypto?: ScheduleIdCrypto }).crypto;
  const randomUUID = crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(crypto);

  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

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
   * bureau built over its `.persistence()` store.
   */
  engine: AnyRunEngine;
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
   * progress. Defaults to `'skip'` (drop the new run silently).
   */
  overlap?: ScheduleOverlapPolicy;
  /**
   * Optional stable id for this schedule (used by `getSchedule`/`pauseSchedule`
   * etc.). Defaults to a uuid assigned by Weft.
   */
  id?: string;
  /**
   * When true with a stable `id`, an existing compatible schedule is treated as
   * success. This is for durable replay of effectful schedule registration.
   */
  idempotent?: boolean;
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
}

/**
 * Engine-level scheduling surface used by {@link AgentScheduler}.
 *
 * Extracted so tests can provide a partial stub without implementing the full
 * `AnyRunEngine` interface.
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
  /** Overlap policy. Defaults to `'skip'`. */
  overlap?: ScheduleOverlapPolicy;
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

function scheduleHandleFromEngine(
  engine: SchedulingEngine,
  scheduleId: string,
): AgentScheduleHandle {
  return {
    id: scheduleId,
    pause: () => engine.pauseSchedule(scheduleId),
    resume: () => engine.resumeSchedule(scheduleId),
    cancel: () => engine.cancelSchedule(scheduleId),
    async describe(): Promise<ScheduleSummary> {
      const schedule = await engine.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error(`Schedule ${scheduleId} no longer exists.`);
      }
      return schedule;
    },
  };
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
 * race the session write-back).
 */
export async function createAgentSchedule(
  options: CreateAgentScheduleOptions,
): Promise<AgentScheduleHandle> {
  const { engine, agentName, spec, input, description, session, overlap, id, idempotent } = options;
  const workflowType = options.workflowType ?? 'agentRun';

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
  const scheduleId = id?.trim() ?? createScheduleId();

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
      return scheduleHandleFromEngine(engine, scheduleId);
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
        return scheduleHandleFromEngine(engine, scheduleId);
      }
    }
    throw error;
  }

  return {
    id: handle.id,
    pause: () => handle.pause(),
    resume: () => handle.resume(),
    cancel: () => handle.cancel(),
    describe: () => handle.describe(),
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
}): AgentScheduler {
  const { engine } = options;
  const workflowType = options.workflowType ?? 'agentRun';

  return {
    async schedule(
      agentName: string,
      scheduleOptions: AgentScheduleOptions,
    ): Promise<AgentScheduleHandle> {
      return createAgentSchedule({
        engine: engine as AnyRunEngine,
        workflowType,
        agentName,
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
