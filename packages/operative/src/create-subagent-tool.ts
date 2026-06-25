import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';
import type { TypedEventTarget } from 'lifecycle';
import type { ZodType } from 'zod';

import type { OperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';
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
  /**
   * F1/F3 — parent run context for event emission.
   *
   * When provided, a `ChildWorkflowStartedEvent` is dispatched on the emitter
   * each time the subagent tool executes, carrying the parent agent name, parent
   * run id, child agent name, input, and whether the child is durable.
   *
   * The `durable` flag must be set to `true` when the child run is started as a
   * Weft child workflow (i.e. when the bureau has `.persistence()` set).
   */
  parentContext?: {
    emitter: TypedEventTarget<OperativeEventMap>;
    parentAgentName: string;
    parentRunId: string;
    /** True when the bureau has `.persistence()` configured (durable child workflow). */
    durable: boolean;
  };
}

/**
 * Creates a tool that delegates execution to a sub-agent.
 *
 * F1: When `parentContext` is supplied the tool emits a `ChildWorkflowStartedEvent`
 * on every execution, exposing the multi-agent delegation transition as an
 * observable event (C3 completeness rule — every state transition emits an event
 * and exposes a hook).
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
    parentContext,
  } = options;

  return createTool({
    name,
    description,
    input,
    execute: async (params: unknown, context: ToolContext) => {
      const prompt = mapInput(params);

      // F1 — emit ChildWorkflowStartedEvent before the child run begins.
      if (parentContext) {
        parentContext.emitter.dispatchEvent(
          new ChildWorkflowStartedEvent({
            parentAgentName: parentContext.parentAgentName,
            parentRunId: parentContext.parentRunId,
            childAgentName: agentName,
            input: prompt,
            durable: parentContext.durable,
          }),
        );
      }

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

      if (result.finishReason === 'budget-exceeded') {
        throw new Error(`Sub-agent "${agentName}" exceeded its token budget`);
      }

      if (result.finishReason === 'elicitation-denied') {
        throw new Error(`Sub-agent "${agentName}" was denied elicitation`);
      }

      if (result.finishReason === 'maximum-steps' && treatMaximumStepsAsError) {
        throw new Error(`Sub-agent "${agentName}" exceeded maximum steps`);
      }

      return mapOutput(result);
    },
  });
}
