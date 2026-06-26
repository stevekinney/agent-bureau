import { createTool } from 'armorer';
import type { TypedEventTarget } from 'lifecycle';
import { z } from 'zod';

import type { RegistryAgent } from './create-agent-registry';
import type { OperativeEventMap } from './events';
import { HandoffOccurredEvent } from './events';

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
  /**
   * F2 — source agent context for event emission + durable session continuation.
   *
   * When provided, a `HandoffOccurredEvent` is dispatched on the emitter when the
   * handoff tool executes, exposing the transition as an observable event (C3
   * completeness rule).
   *
   * The `sessionId` is included when the handoff is session-scoped — i.e. the
   * handoff creates a new run in the SAME session bound to the target agent
   * (durable session continuation, F2). Without a sessionId the handoff is the
   * legacy marker-based in-process pattern.
   */
  sourceContext?: {
    emitter: TypedEventTarget<OperativeEventMap>;
    sourceAgentName: string;
    /** Session id when the handoff is a durable session-continuation (F2). */
    sessionId?: string;
  };
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
 *
 * F2: When `sourceContext` is provided with a `sessionId`, the handoff is a
 * durable session-continuation — the target agent's run will be appended to the
 * same session as the source run. Each `RunRef` in the session carries the
 * `agentName` of the agent that handled it, so the session is a full audit trail
 * of which agent ran each run (architecture.md §F2).
 */
export function createHandoffTool(options: CreateHandoffToolOptions) {
  const { agent, input = z.object({}), sourceContext } = options;
  const name = options.name ?? `transfer_to_${agent.name}`;
  const description =
    options.description ?? `Hand off the conversation to the "${agent.name}" agent.`;

  return createTool({
    name,
    description,
    input,
    execute: () => {
      // F2 — emit HandoffOccurredEvent so the transition is observable.
      if (sourceContext) {
        sourceContext.emitter.dispatchEvent(
          new HandoffOccurredEvent({
            sourceAgentName: sourceContext.sourceAgentName,
            targetAgentName: agent.name,
            sessionId: sourceContext.sessionId,
          }),
        );
      }

      return Promise.resolve(
        JSON.stringify({
          type: HANDOFF_MARKER,
          agent: agent.name,
        }),
      );
    },
  });
}
