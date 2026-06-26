import type { ScheduleOverlapPolicy, ScheduleSpec } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentScheduleHandle } from './durable/schedule-agent';

/**
 * Input shape for the `scheduleSelf` tool. The agent calls this tool to
 * register a recurring schedule for its OWN run.
 *
 * @example
 * ```ts
 * // Agent: "Run me every morning at 9am, accumulating into this session"
 * scheduleSelf({
 *   spec: { cron: '0 9 * * *' },
 *   input: 'Summarize overnight activity',
 *   session: 'daily-digest',
 * });
 *
 * // Agent: "Run me every 6 hours as a fresh stateless job"
 * scheduleSelf({ spec: { every: '6h' }, input: 'Check deploy status' });
 * ```
 */
export interface ScheduleSelfInput {
  /**
   * The recurrence specification. Exactly one of `cron` (cron expression) or
   * `every` (fixed interval) must be supplied.
   *
   * @example { cron: '0 9 * * *' }  // daily at 9am
   * @example { every: '6h' }          // every 6 hours
   */
  spec: ScheduleSpec;
  /**
   * The prompt / input to inject into each scheduled fire of this agent.
   */
  input: string;
  /**
   * Optional session id to accumulate all scheduled fires into. When present,
   * each fire APPENDS a new run to this session (recurring conversation,
   * accumulates context across fires). When absent, each fire starts a FRESH
   * standalone session (stateless cron job).
   *
   * Architecture: "an agent that wakes daily and remembers what it found
   * yesterday" — set `session` to the current session id.
   */
  session?: string;
  /**
   * How to handle a tick that fires while a previous run is still in progress.
   * Defaults to `'skip'` (drop the new run silently).
   */
  overlap?: ScheduleOverlapPolicy;
}

/** Output returned to the LLM when `scheduleSelf` is called. */
export interface ScheduleSelfResult {
  scheduled: true;
  scheduleId: string;
  /** Human-readable confirmation message the LLM can surface. */
  message: string;
}

/**
 * The scheduling function injected into the `scheduleSelf` tool. In
 * production this is `AgentScheduler.schedule`; in tests, a spy or stub.
 */
export type ScheduleSelfFn = (
  agentName: string,
  options: {
    spec: ScheduleSpec;
    input: string;
    session?: string;
    overlap?: ScheduleOverlapPolicy;
  },
) => Promise<AgentScheduleHandle>;

/**
 * Options for {@link createScheduleSelfTool}.
 */
export interface CreateScheduleSelfToolOptions {
  /**
   * The agent name that will be registered on the schedule. In production this
   * is the agent's canonical name (the same name the bureau dispatches with).
   */
  agentName: string;
  /**
   * The scheduler's `schedule` method bound to the bureau engine. Called when
   * the tool executes. In production this is `agentScheduler.schedule`; in
   * tests, pass a spy function.
   */
  schedule: ScheduleSelfFn;
}

/**
 * Creates the `scheduleSelf` self-scheduling tool (D6 — Tier-1 scheduling).
 *
 * The agent calls this tool to register a RECURRING schedule for its own
 * agent name. The schedule fires `agentName` on the given `spec`, optionally
 * accumulating runs into a session (the "agent that wakes daily and remembers
 * what it found yesterday" pattern).
 *
 * This is an **opt-in built-in tool** — the bureau or agent explicitly adds it
 * to the toolbox. It requires a durable engine (the scheduler wraps
 * `engine.schedule`); calling it without one results in an error propagated to
 * the LLM.
 *
 * Architecture note: `scheduleSelf` is **not** the same as `scheduleWakeup`.
 * `scheduleWakeup` parks the CURRENT run (one-shot sleep-then-resume);
 * `scheduleSelf` registers a RECURRING external schedule on the fleet (Scope 2
 * in the architecture taxonomy: agent → bureau, new session/run on the fleet).
 *
 * @example
 * ```ts
 * // In bureau setup (Phase E):
 * const tool = createScheduleSelfTool({
 *   agentName: 'daily-digest',
 *   schedule: scheduler.schedule.bind(scheduler),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Standalone (test):
 * const schedules: Array<{ agentName: string; options: unknown }> = [];
 * const tool = createScheduleSelfTool({
 *   agentName: 'test-agent',
 *   schedule: async (name, opts) => {
 *     schedules.push({ agentName: name, options: opts });
 *     return { id: 'sched-1', pause: async () => {}, resume: async () => {},
 *              cancel: async () => {}, describe: async () => mockSummary };
 *   },
 * });
 * const result = await tool.execute({ spec: { every: '1h' }, input: 'hello' });
 * expect(result.scheduleId).toBe('sched-1');
 * ```
 */
export function createScheduleSelfTool(options: CreateScheduleSelfToolOptions) {
  const { agentName, schedule } = options;

  return {
    name: 'scheduleSelf',
    description:
      "Register a recurring schedule for this agent's own name. " +
      'Provide a cron expression or interval (e.g. every 6h). ' +
      'Supply a session id to accumulate runs into an ongoing conversation.',

    /**
     * Zod schema for the tool's input arguments. Armorer's `createToolbox`
     * calls `normalizeSchema` on this field; without it the schema defaults to
     * `z.object({})` which strips `spec`, `input`, `session`, and `overlap`
     * before `execute` receives them, causing the tool to fail with undefined
     * values.
     */
    input: z.object({
      spec: z
        .union([
          z.object({ cron: z.string(), every: z.never().optional() }).describe('Cron schedule'),
          z
            .object({ every: z.union([z.number(), z.string()]), cron: z.never().optional() })
            .describe('Fixed interval'),
        ])
        .describe(
          'The recurrence specification. Provide either cron (a cron expression) or ' +
            'every (a fixed interval such as "6h", "30m", or milliseconds as a number).',
        ),
      input: z
        .string()
        .describe('The prompt or input to inject into each scheduled fire of this agent.'),
      session: z
        .string()
        .optional()
        .describe(
          'Optional session id to accumulate all scheduled fires into. When present, ' +
            'each fire appends a new run to this session. When absent, each fire starts ' +
            'a fresh standalone session.',
        ),
      overlap: z
        .enum(['skip', 'queue', 'cancel-running', 'allow'])
        .optional()
        .describe(
          'How to handle a tick that fires while a previous run is still in progress. ' +
            'Defaults to skip.',
        ),
    }),

    /**
     * Execute the `scheduleSelf` tool. Registers a durable Weft schedule for
     * this agent and returns the new schedule id.
     *
     * @param input - `spec`, `input`, optional `session`, optional `overlap`.
     * @returns A confirmation with the assigned `scheduleId`.
     */
    async execute(input: ScheduleSelfInput): Promise<ScheduleSelfResult> {
      const handle = await schedule(agentName, {
        spec: input.spec,
        input: input.input,
        ...(input.session !== undefined ? { session: input.session } : {}),
        ...(input.overlap !== undefined ? { overlap: input.overlap } : {}),
      });

      const specLabel =
        'cron' in input.spec ? `cron '${input.spec.cron}'` : `every ${String(input.spec.every)}`;

      const sessionLabel = input.session
        ? ` into session '${input.session}'`
        : ' (fresh session each fire)';

      return {
        scheduled: true,
        scheduleId: handle.id,
        message: `Registered recurring schedule (${specLabel})${sessionLabel}. Schedule id: ${handle.id}`,
      };
    },
  } as const;
}

/** The type of the tool object created by {@link createScheduleSelfTool}. */
export type ScheduleSelfTool = ReturnType<typeof createScheduleSelfTool>;
