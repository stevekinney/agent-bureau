import { z } from 'zod';

import type { PendingHumanWait } from './durable/types';
import { HumanWaitParkedEvent } from './events';

type HumanInputEventDispatcher = {
  dispatchEvent(event: Event): boolean;
};

/**
 * Input shape for the `requestHumanInput` tool.
 *
 * @example
 * ```ts
 * // Agent: "I need human approval before proceeding"
 * requestHumanInput({ signalName: 'human-response', prompt: 'Please approve this action' });
 * ```
 */
export interface RequestHumanInputInput {
  /**
   * The signal name the run will park on. The human sends the same name when
   * releasing the run (e.g. `'human-response'`).
   */
  signalName: string;
  /**
   * Optional prompt to surface to the human reviewer. This is returned in the
   * tool result and in the `HumanWaitParkedEvent` so callers can display it.
   */
  prompt?: string;
}

/** Output returned to the LLM when `requestHumanInput` is called. */
export interface RequestHumanInputResult {
  parked: true;
  signalName: string;
  prompt?: string;
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/**
 * The interface the `requestHumanInput` tool needs from its context.
 *
 * Designed for testability: tests pass a plain object instead of a full
 * `DurableRunDeps`.
 */
export interface RequestHumanInputContext {
  /** Mutable slot — the tool writes the human-wait request here. */
  pendingHumanWait: PendingHumanWait | undefined;
  /**
   * Optional run id, used in the emitted event so observers can correlate the
   * park event to a specific run. Falls back to `''` when omitted.
   */
  runId?: string;
}

/**
 * Options for {@link createRequestHumanInputTool}.
 */
export interface CreateRequestHumanInputToolOptions {
  /**
   * The mutable context the tool writes the human-wait request into. In
   * production this is the `DurableRunDeps` object (the tool and the workflow
   * share the same in-process reference). In tests, pass a plain
   * `{ pendingHumanWait: undefined }` stub.
   */
  context: RequestHumanInputContext;
  /**
   * Optional event emitter. When provided, a `HumanWaitParkedEvent` is
   * dispatched each time the tool executes (C3 completeness rule — every state
   * transition emits an event).
   */
  emitter?: HumanInputEventDispatcher;
}

/**
 * Creates the `requestHumanInput` HITL tool (F3 — Human-in-the-loop).
 *
 * The agent calls this tool during a durable run to park the current workflow
 * until a human sends a named signal. Under the hood it sets a
 * `pendingHumanWait` flag on the run's `DurableRunDeps`; the `agentRun`
 * workflow checks this flag after the main step loop exits and performs
 * `yield* ctx.waitForSignal(signalName)` to actually park the Weft workflow.
 *
 * This is an **opt-in built-in tool** — the bureau or agent explicitly adds it
 * to the toolbox (no ambient grant). It only works in a durable run; calling it
 * in an in-memory run is a no-op (no error, just no parking).
 *
 * C3 completeness: when an `emitter` is provided, a `HumanWaitParkedEvent` is
 * dispatched BEFORE the tool result is returned so observers see the park event
 * synchronously with the tool call.
 *
 * @example
 * ```ts
 * // In bureau setup (Phase E):
 * const bureau = createBureau()
 *   .tools({
 *     requestHumanInput: createRequestHumanInputTool({ context: durableRunDeps, emitter }),
 *   });
 * ```
 *
 * @example
 * ```ts
 * // Standalone (test):
 * const ctx = { pendingHumanWait: undefined };
 * const tool = createRequestHumanInputTool({ context: ctx });
 * await tool.execute({ signalName: 'human-response', prompt: 'Approve this?' });
 * expect(ctx.pendingHumanWait?.signalName).toBe('human-response');
 * ```
 */
export function createRequestHumanInputTool(options: CreateRequestHumanInputToolOptions) {
  const { context, emitter } = options;

  return {
    name: 'requestHumanInput',
    description:
      'Request human input: park this run until a human sends the named signal. ' +
      'Use when the agent needs explicit human approval or a human decision before continuing.',

    /**
     * Zod schema for the tool's input arguments. Armorer's `createToolbox`
     * calls `normalizeSchema` on this field; without it the schema defaults to
     * `z.object({})` which strips `signalName` and `prompt` before `execute`
     * receives them, causing `pendingHumanWait.signalName` to be `undefined`
     * and the durable run to park on an unreachable signal.
     */
    input: z.object({
      signalName: z
        .string()
        .describe(
          'The signal name the run will park on. The human sends the same name when ' +
            'releasing the run (e.g. "human-response").',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Optional prompt to surface to the human reviewer. Returned in the tool ' +
            'result and in the HumanWaitParkedEvent so callers can display it.',
        ),
    }),

    execute(input: RequestHumanInputInput): RequestHumanInputResult {
      context.pendingHumanWait = {
        signalName: input.signalName,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      };

      // F3 / C3 — emit HumanWaitParkedEvent so observers see the transition.
      // Thread the prompt through so UI/event-stream consumers can display what
      // approval or input is being requested (as the schema doc promises).
      if (emitter) {
        emitter.dispatchEvent(
          new HumanWaitParkedEvent(input.signalName, context.runId ?? '', input.prompt),
        );
      }

      const message = input.prompt
        ? `Parked waiting for human signal "${input.signalName}". Prompt: ${input.prompt}`
        : `Parked waiting for human signal "${input.signalName}".`;

      return {
        parked: true,
        signalName: input.signalName,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        message,
      };
    },
  } as const;
}

/** The type of the tool object created by {@link createRequestHumanInputTool}. */
export type RequestHumanInputTool = ReturnType<typeof createRequestHumanInputTool>;
