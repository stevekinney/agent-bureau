import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';
import type { ZodType } from 'zod';

import type { RunResult } from './types';

/**
 * Options for creating a tool that delegates execution to a sub-agent.
 *
 * The agent is represented as an async callable that accepts a string input
 * and returns a RunResult. This decouples the tool from any specific agent
 * construction API (defineAgent is gone; createAgent / bureau.agent come in B3).
 */
export interface CreateSubagentToolOptions {
  name: string;
  description: string;
  /** Callable that executes the sub-agent given a string prompt and optional context. */
  run: (
    input: string,
    context: { signal?: AbortSignal; traceContext?: unknown },
  ) => Promise<RunResult>;
  /** Agent name, used in error messages. */
  agentName: string;
  input: ZodType;
  mapInput?: (input: unknown) => string;
  mapOutput?: (result: RunResult) => unknown;
  /**
   * When true (the default), a sub-agent finishing with `maximum-steps` is
   * treated as an error and throws. Set to false to accept partial results.
   */
  treatMaximumStepsAsError?: boolean;
}

/**
 * Creates a tool that delegates execution to a sub-agent.
 */
export function createSubagentTool(options: CreateSubagentToolOptions) {
  const {
    name,
    description,
    run,
    agentName,
    input,
    mapInput = (params: unknown) => String(params),
    mapOutput = (result: RunResult) => result.content,
    treatMaximumStepsAsError = true,
  } = options;

  return createTool({
    name,
    description,
    input,
    execute: async (params: unknown, context: ToolContext) => {
      const prompt = mapInput(params);

      const result = await run(prompt, {
        signal: context.signal,
        traceContext: context.traceContext,
      });

      if (result.finishReason === 'error') {
        throw new Error(`Sub-agent "${agentName}" finished with error`);
      }

      if (result.finishReason === 'aborted') {
        throw new Error(`Sub-agent "${agentName}" was aborted`);
      }

      if (result.finishReason === 'maximum-steps' && treatMaximumStepsAsError) {
        throw new Error(`Sub-agent "${agentName}" exceeded maximum steps`);
      }

      return mapOutput(result);
    },
  });
}
