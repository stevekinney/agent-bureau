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
const CHARACTERS_PER_TOKEN = 4;

/**
 * Hard-truncates `text` to at most `maxTokens` worth of characters —
 * INCLUDING the truncation marker itself, so the returned string's length
 * never exceeds `maxTokens * CHARACTERS_PER_TOKEN` characters. Negative or
 * fractional `maxTokens` are clamped to `0`.
 *
 * This is what makes `summaryTokenCap` an actual guarantee rather than a
 * suggestion: `createSubagentTool` applies it to whatever `summarizer`
 * returns — including a caller-supplied one — not just to the default
 * summarizer's own truncation logic.
 */
function enforceTokenCap(text: string, maxTokens: number): string {
  const safeMaxTokens = Math.max(0, Math.floor(maxTokens));
  const maxChars = safeMaxTokens * CHARACTERS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  const marker = `\n\n[truncated to fit the ~${safeMaxTokens} token cap]`;
  const contentBudget = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, contentBudget)}${marker}`.slice(0, maxChars);
}

/**
 * Context passed to a `SubagentSummarizer` alongside the sub-agent's
 * `RunResult`.
 */
export interface SubagentSummaryContext {
  /** The sub-agent's name, as passed to `createSubagentTool`. */
  agentName: string;
  /** The configured `summaryTokenCap` the summarizer should condense to. */
  maxTokens: number;
  /**
   * The parent tool call's abort signal, when one was supplied. An
   * async/LLM-backed summarizer should pass this through to whatever it
   * awaits (e.g. `fetch(url, { signal })`) so an aborted parent run doesn't
   * leave summarization work running in the background after the tool call
   * has already been cancelled.
   */
  signal?: AbortSignal;
}

/**
 * Condenses a completed sub-agent run into a string the parent agent's
 * context window can afford. Receives the full `RunResult` — not just
 * `content` — so a custom summarizer can factor in `usage`, `steps`, or
 * `finishReason` when deciding what to keep.
 *
 * A summarizer's return value is NOT trusted as already within budget:
 * `createSubagentTool` hard-caps whatever it returns via `enforceTokenCap`
 * before it reaches the parent, so `summaryTokenCap` holds even if a custom
 * summarizer ignores `maxTokens` entirely.
 */
export type SubagentSummarizer = (
  result: RunResult,
  context: SubagentSummaryContext,
) => string | Promise<string>;

/**
 * Default summarizer: passes `result.content` through unchanged when it
 * already fits within `maxTokens`, otherwise hard-truncates it via
 * `enforceTokenCap`. This is a naive character-based cap, not genuine
 * summarization — callers that need real condensation (e.g. an LLM call
 * that distills the sub-agent's output) should supply their own
 * `summarizer`.
 */
export const defaultSubagentSummarizer: SubagentSummarizer = (result, { maxTokens }) =>
  enforceTokenCap(result.content, maxTokens);

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
      // The summarizer's output is hard-capped here regardless of what it
      // returns — summaryTokenCap is a guarantee enforced by the tool, not
      // a suggestion the summarizer has to honor itself.
      //
      // The signal is checked both before and after the summarizer runs: a
      // custom/LLM-backed summarizer may not itself observe `signal`, so an
      // abort that lands mid-summarization would otherwise go unnoticed by
      // the tool and let the run continue to consume tokens in the
      // background. Passing `signal` through `SubagentSummaryContext` also
      // lets a summarizer that DOES respect it (e.g. via `fetch`) cancel its
      // own in-flight work immediately.
      context.signal?.throwIfAborted();
      const summarizedContent = await summarizer(result, {
        agentName,
        maxTokens: summaryTokenCap,
        signal: context.signal,
      });
      context.signal?.throwIfAborted();
      const cappedContent = enforceTokenCap(summarizedContent, summaryTokenCap);
      return mapOutput({ ...result, content: cappedContent });
    },
  });
}
