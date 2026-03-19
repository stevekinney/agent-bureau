import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';

import type { CreateSubagentToolOptions, RunResult } from './types';

/**
 * Creates a tool that delegates execution to a sub-agent.
 */
export function createSubagentTool(options: CreateSubagentToolOptions) {
  const {
    name,
    description,
    agent,
    input,
    mapInput = (params: unknown) => String(params),
    mapOutput = (result: RunResult) => result.content,
  } = options;

  return createTool({
    name,
    description,
    input,
    execute: async (params: unknown, context: ToolContext) => {
      const agentInput = mapInput(params);
      const signal = context.signal as AbortSignal | undefined;
      const agentRunOptions =
        typeof agentInput === 'string'
          ? { conversation: agentInput, signal }
          : { ...agentInput, signal: signal ?? agentInput.signal };

      const result = await agent.run(agentRunOptions);

      if (result.finishReason === 'error') {
        throw new Error(`Sub-agent "${agent.name}" finished with error`);
      }

      return mapOutput(result);
    },
  });
}
