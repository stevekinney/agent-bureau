import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';
import type { TypedEventTarget } from 'lifecycle';
import type { ZodType } from 'zod';

import { GuardrailTripwireError } from './errors';
import type { OperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';
import type { RunResult } from './types';

/**
 * Roughly 4 characters per token — the same coarse estimate used by
 * `context/token-budget.ts`'s default estimator. Good enough for capping a
 * summary; not a substitute for a real tokenizer.
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Context passed to a `SubagentSummarizer` alongside the sub-agent's
 * `RunResult`.
 */
export interface SubagentSummaryContext {
  /** The sub-agent's name, as passed to `createSubagentTool`. */
  agentName: string;
  /** The configured `summaryTokenCap` the summarizer should condense to. */
  maxTokens: number;
}

/**
 * Condenses a completed sub-agent run into a string the parent agent's
 * context window can afford. Receives the full `RunResult` — not just
 * `content` — so a custom summarizer can factor in `usage`, `steps`, or
 * `finishReason` when deciding what to keep.
 */
export type SubagentSummarizer = (
  result: RunResult,
  context: SubagentSummaryContext,
) => string | Promise<string>;

/**
 * Default summarizer: passes `result.content` through unchanged when it
 * already fits within `maxTokens`, otherwise truncates it and appends a
 * marker noting how much was cut. This is a naive character-based cap, not
 * genuine summarization — callers that need real condensation (e.g. an LLM
 * call that distills the sub-agent's output) should supply their own
 * `summarizer`.
 */
export const defaultSubagentSummarizer: SubagentSummarizer = (result, { maxTokens }) => {
  const { content } = result;
  const tokens = estimateTokens(content);
  if (tokens <= maxTokens) return content;

  const maxChars = maxTokens * 4;
  const truncated = content.slice(0, maxChars);
  const omittedTokens = tokens - maxTokens;
  return `${truncated}\n\n[summary truncated to ~${maxTokens} tokens — ~${omittedTokens} tokens omitted]`;
};

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
  /**
   * Maps the (possibly summarized) `RunResult` to the tool's return value.
   * Runs AFTER `returnMode`/`summarizer` have already condensed
   * `result.content` — a custom `mapOutput` still sees the summarized
   * content by default, not the raw sub-agent output.
   */
  mapOutput?: (result: RunResult) => unknown;
  /**
   * AB-64 — controls how much of the sub-agent's context comes back to the
   * parent agent.
   *
   * - `'summary'` (the default): the sub-agent's own conversation, steps, and
   *   full transcript stay isolated in its own context window. Only a
   *   condensed summary of its `content` — capped at `summaryTokenCap`
   *   tokens — crosses back into the parent's context. This is what keeps a
   *   multi-agent fan-out from blowing up the orchestrator's context window
   *   as sub-agents accumulate.
   * - `'full'`: `result.content` is returned unmodified, uncapped. Use this
   *   deliberately — e.g. when the parent genuinely needs the sub-agent's
   *   verbatim output (structured data extraction, a single close-coupled
   *   delegation) — not as the default posture for fan-out.
   */
  returnMode?: 'summary' | 'full';
  /**
   * Condenses the sub-agent's `RunResult` into the string returned to the
   * parent when `returnMode` is `'summary'`. Defaults to
   * `defaultSubagentSummarizer` (character-based truncation). Ignored when
   * `returnMode` is `'full'`.
   */
  summarizer?: SubagentSummarizer;
  /**
   * Token budget for the summary returned to the parent when `returnMode`
   * is `'summary'`. Defaults to `500`. Ignored when `returnMode` is
   * `'full'`.
   */
  summaryTokenCap?: number;
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
    returnMode = 'summary',
    summarizer = defaultSubagentSummarizer,
    summaryTokenCap = 500,
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

      if (result.finishReason === 'tripwire') {
        const guardrailName =
          result.error instanceof GuardrailTripwireError ? result.error.guardrailName : 'unknown';
        throw new Error(
          `Sub-agent "${agentName}" was halted by guardrail tripwire "${guardrailName}"`,
        );
      }

      if (result.finishReason === 'maximum-steps' && treatMaximumStepsAsError) {
        throw new Error(`Sub-agent "${agentName}" exceeded maximum steps`);
      }

      if (returnMode === 'full') {
        return mapOutput(result);
      }

      // AB-64 — condense the sub-agent's context down to a capped summary
      // before it crosses back into the parent. Only `content` is replaced;
      // `mapOutput` still receives the rest of the RunResult untouched.
      const summarizedContent = await summarizer(result, { agentName, maxTokens: summaryTokenCap });
      return mapOutput({ ...result, content: summarizedContent });
    },
  });
}
