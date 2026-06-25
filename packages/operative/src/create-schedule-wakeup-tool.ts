import { z } from 'zod';

import type { PendingWakeup } from './durable/types';

/**
 * Input shape for the `scheduleWakeup` tool. The agent calls this tool to
 * park the current durable run for `in` (a human-readable duration or
 * milliseconds) and resume later.
 *
 * @example
 * ```ts
 * // Agent: "I'll check the deploy status in 6 hours"
 * scheduleWakeup({ in: '6h', note: 'Check deploy status' });
 * ```
 */
export interface ScheduleWakeupInput {
  /**
   * How long to sleep before resuming. Accepts a Weft `Duration`:
   * - milliseconds as a number (e.g. `21_600_000`)
   * - human-readable string (e.g. `'6h'`, `'30m'`, `'500ms'`)
   * - ISO-8601 duration (e.g. `'PT6H'`)
   */
  in: number | string;
  /**
   * Optional note the agent attaches to the wakeup. Carried in the workflow
   * result and surfaced to the next run so it knows why it resumed.
   *
   * @example 'Wake me up to check if the deploy succeeded.'
   */
  note?: string;
}

/** Output returned to the LLM when `scheduleWakeup` is called. */
export interface ScheduleWakeupResult {
  scheduled: true;
  duration: number | string;
  note?: string;
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/**
 * The interface the `scheduleWakeup` tool needs from its context. The
 * `pendingWakeup` mutable slot lives on `DurableRunDeps.pendingWakeup` and is
 * injected here via the tool factory.
 *
 * Designed for testability: tests pass a plain object with a `pendingWakeup`
 * property instead of a full `DurableRunDeps`.
 */
export interface ScheduleWakeupContext {
  /** Mutable slot — the tool writes the wakeup request here. */
  pendingWakeup: PendingWakeup | undefined;
}

/**
 * Options for {@link createScheduleWakeupTool}.
 */
export interface CreateScheduleWakeupToolOptions {
  /**
   * The mutable context the tool writes the wakeup request into. In production
   * this is the `DurableRunDeps` object (the tool and the workflow share the
   * same in-process reference). In tests, pass a plain `{ pendingWakeup:
   * undefined }` stub.
   */
  context: ScheduleWakeupContext;
}

/**
 * Creates the `scheduleWakeup` self-scheduling tool (D6 — Tier-1 scheduling).
 *
 * The agent calls this tool during a durable run to park the current workflow
 * for a specified duration and resume later. Under the hood it sets a
 * `pendingWakeup` flag on the run's `DurableRunDeps`; the `agentRun` workflow
 * checks this flag after the main step loop exits and performs
 * `yield* ctx.sleep(duration)` to actually park the Weft workflow.
 *
 * This is an **opt-in built-in tool** — the bureau or agent explicitly adds it
 * to the toolbox (no ambient grant). It only works in a durable run; calling it
 * in an in-memory run is a no-op (no error, just no parking).
 *
 * @example
 * ```ts
 * // In bureau setup (Phase E):
 * const bureau = createBureau()
 *   .tools({
 *     scheduleWakeup: createScheduleWakeupTool({ context: durableRunDeps }),
 *   });
 * ```
 *
 * @example
 * ```ts
 * // Standalone (test):
 * const ctx = { pendingWakeup: undefined };
 * const tool = createScheduleWakeupTool({ context: ctx });
 * await tool.execute({ in: '6h', note: 'Check deploy' });
 * expect(ctx.pendingWakeup?.duration).toBe('6h');
 * ```
 */
export function createScheduleWakeupTool(options: CreateScheduleWakeupToolOptions) {
  const { context } = options;

  return {
    name: 'scheduleWakeup',
    description:
      'Schedule a wakeup: park this run for the given duration and resume automatically. ' +
      'Use to sleep until a future event (e.g. "wake me in 6h to check the deploy").',

    /**
     * Zod schema for the tool's input arguments. Armorer's `createToolbox`
     * calls `normalizeSchema` on this field; without it the schema defaults to
     * `z.object({})` which strips `in` and `note` before `execute` receives them.
     */
    input: z.object({
      in: z
        .union([z.number(), z.string()])
        .describe(
          'How long to sleep before resuming. Accepts milliseconds as a number ' +
            'or a human-readable string (e.g. "6h", "30m", "500ms") ' +
            'or an ISO-8601 duration (e.g. "PT6H").',
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Optional note the agent attaches to the wakeup, surfaced to the next ' +
            'run so it knows why it resumed.',
        ),
    }),

    /**
     * Execute the `scheduleWakeup` tool. Writes the wakeup request into the
     * shared context so the durable workflow can park after the step loop exits.
     *
     * @param input - The wakeup request: `in` (duration) + optional `note`.
     * @returns A confirmation result surfaced to the LLM.
     */
    execute(input: ScheduleWakeupInput): ScheduleWakeupResult {
      context.pendingWakeup = {
        duration: input.in,
        ...(input.note !== undefined ? { note: input.note } : {}),
      };

      const durationLabel = typeof input.in === 'number' ? `${input.in}ms` : input.in;

      const message = input.note
        ? `Wakeup scheduled in ${durationLabel}. Note: ${input.note}`
        : `Wakeup scheduled in ${durationLabel}.`;

      return {
        scheduled: true,
        duration: input.in,
        ...(input.note !== undefined ? { note: input.note } : {}),
        message,
      };
    },
  } as const;
}

/** The type of the tool object created by {@link createScheduleWakeupTool}. */
export type ScheduleWakeupTool = ReturnType<typeof createScheduleWakeupTool>;
