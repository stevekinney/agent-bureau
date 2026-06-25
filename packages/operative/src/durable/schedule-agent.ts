import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';

import type { AnyRunEngine } from './create-run-engine';

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
}

/**
 * Register a single recurring durable agent schedule against the given Weft
 * engine. Called by `AgentScheduler.schedule(...)`.
 *
 * @returns An {@link AgentScheduleHandle} that wraps the Weft `ScheduleHandle`.
 */
export async function createAgentSchedule(
  options: CreateAgentScheduleOptions,
): Promise<AgentScheduleHandle> {
  const workflowType = options.workflowType ?? 'agentRun';
  const input: ScheduledAgentRunInput = {
    agentName: options.agentName,
    input: options.input,
    ...(options.session ? { sessionId: options.session } : {}),
  };
  const scheduleOptions: ScheduleOptions = {
    ...(options.id ? { id: options.id } : {}),
    overlap: options.overlap ?? 'skip',
  };

  const handle = await options.engine.schedule(workflowType, input, options.spec, scheduleOptions);

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
