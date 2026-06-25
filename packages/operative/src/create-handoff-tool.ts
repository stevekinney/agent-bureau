import { createTool } from 'armorer';
import { z } from 'zod';

import type { RegistryAgent } from './create-agent-registry';

/**
 * Marker value embedded in the tool result so callers can extract
 * handoff metadata from `RunResult.steps`.
 */
export const HANDOFF_MARKER = '__handoff__' as const;

/**
 * Options for creating a handoff tool.
 */
export interface CreateHandoffToolOptions {
  /** Tool name. Defaults to `transfer_to_<agent.name>`. */
  name?: string;
  /** Tool description shown to the model. */
  description?: string;
  /** The agent to hand off to. */
  agent: RegistryAgent;
  /** Optional Zod schema for the tool's input. Defaults to an empty object. */
  input?: z.ZodType;
}

/**
 * Extracts handoff metadata from a completed run's final step, if present.
 * Returns the target agent name or `undefined` if no handoff occurred.
 */
export function extractHandoffTarget(
  steps: readonly { results: readonly { content: string }[] }[],
): string | undefined {
  const lastStep = steps[steps.length - 1];
  if (!lastStep) return undefined;

  for (const result of lastStep.results) {
    try {
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && parsed['type'] === HANDOFF_MARKER) {
        return parsed['agent'] as string;
      }
    } catch {
      // Not JSON — skip.
    }
  }

  return undefined;
}

/**
 * Creates a tool that signals a handoff to another agent. When paired with
 * `stopWhen.toolCalled(name)`, the current loop exits and the caller can
 * inspect `extractHandoffTarget(result.steps)` to determine which agent
 * should continue with the existing conversation.
 *
 * This implements the OpenAI Agents SDK "handoff" pattern: the parent
 * exits and the child continues with the same conversation, unlike
 * `createSubagentTool` where the parent waits for the child.
 */
export function createHandoffTool(options: CreateHandoffToolOptions) {
  const { agent, input = z.object({}) } = options;
  const name = options.name ?? `transfer_to_${agent.name}`;
  const description =
    options.description ?? `Hand off the conversation to the "${agent.name}" agent.`;

  return createTool({
    name,
    description,
    input,
    execute: () => {
      return Promise.resolve(
        JSON.stringify({
          type: HANDOFF_MARKER,
          agent: agent.name,
        }),
      );
    },
  });
}
