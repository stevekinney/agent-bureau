import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';
import type { TypedEventTarget } from 'lifecycle';
import type { ZodType } from 'zod';

import type { AgentInput, RunnableAgent, SuccessfulRunResult } from './agent-run';
import { isSuccessfulRunResult } from './agent-run';
import { SubagentRunError } from './errors';
import type { OperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';

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
 * `SuccessfulRunResult`.
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
 * context window can afford. Receives the full `SuccessfulRunResult` — not
 * just `content` — so a custom summarizer can factor in `usage`, `steps`, or
 * `output` when deciding what to keep. Only ever invoked on a clean success
 * (AB-19): every non-success terminal rejects with `SubagentRunError` before
 * a summarizer is ever reached.
 *
 * A summarizer's return value is NOT trusted as already within budget:
 * `createSubagentTool` hard-caps whatever it returns via `enforceTokenCap`
 * before it reaches the parent, so `summaryTokenCap` holds even if a custom
 * summarizer ignores `maxTokens` entirely.
 */
export type SubagentSummarizer<O = unknown, H extends boolean = boolean> = (
  result: SuccessfulRunResult<O, H>,
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
 * `TInput` drives `toAgentInput`'s parameter type — the parsed output of
 * the `input` schema, matching what the parent LLM actually supplied.
 * `TInput extends object` (rather than reproducing `z.output<TInputSchema>`
 * against an unresolved schema generic) deliberately mirrors `createTool`'s
 * own `TInput extends object` / `input?: z.ZodType<TInput>` overload: two
 * independently-derived deferred conditional types over the same
 * unresolved generic (this package's vs. armorer's own un-exported
 * `InferSchemaInput`) are not structurally unifiable by TypeScript even
 * when semantically identical, so `createSubagentTool` reuses armorer's
 * own object-schema generic shape instead of re-deriving one. `TOutput`/
 * `THasOutput` are the child agent's own output generics, carried straight
 * from `agent: RunnableAgent<TOutput, THasOutput>`; `TToolOutput` is what
 * `toToolOutput` — and therefore this tool's `execute` — returns, which is
 * what `createTool` infers the tool's own output type from.
 */
export interface CreateSubagentToolOptions<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  THasOutput extends boolean = boolean,
  TToolOutput = string,
> {
  name: string;
  description: string;
  /**
   * The child agent (AB-19). `createAgent`'s returned agent satisfies this
   * structurally: its `run(input, context?)` is invoked with the exact
   * `agentName` this tool was constructed with, plus the parent tool call's
   * `signal`, `traceContext`, and this option bag's own `withTraceContext` —
   * so a `createAgent` child receives identical signal, trace context, and
   * `withTraceContext` propagation to what the parent run itself sees.
   */
  agent: RunnableAgent<TOutput, THasOutput>;
  /**
   * Names the child. Passed verbatim to `agent.run(input, { agentName, ... })`
   * and used in `SubagentRunError` and the `ChildWorkflowStartedEvent`'s
   * `childAgentName`/parent-identity fields — never derived from `agent`
   * itself, so a caller can name a child independently of any identity the
   * agent object happens to carry.
   */
  agentName: string;
  input: ZodType<TInput>;
  /**
   * Projects the tool's validated arguments to the child's `AgentInput`
   * (AB-19; renamed from `mapInput`). Receives the input schema's parsed
   * output — the parsed tool-call arguments, not the raw unvalidated call.
   * Defaults to `String(input)`, matching the input schema's raw
   * stringification a caller who supplies no schema-shaped conversion gets
   * today.
   */
  toAgentInput?: (input: TInput) => AgentInput;
  /**
   * Projects the child's completed run to this tool's return value (AB-19;
   * renamed from `mapOutput`). A pure projection, not runtime validation —
   * every non-success terminal has already rejected as `SubagentRunError`
   * before this is ever called, so it only ever sees a
   * `SuccessfulRunResult<TOutput, THasOutput>`. Runs AFTER `returnMode`/
   * `summarizer` have already condensed `result.content` in summary mode —
   * a custom `toToolOutput` still sees the summarized content by default,
   * not the raw sub-agent output. Defaults to `(result) => result.content`,
   * so a schema-less child with no `toToolOutput` returns a string.
   */
  toToolOutput?: (
    result: SuccessfulRunResult<TOutput, THasOutput>,
  ) => TToolOutput | Promise<TToolOutput>;
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
   * - `'full'`: the successful `RunResult` is passed to `toToolOutput`
   *   unmodified, uncapped. Use this deliberately — e.g. when the parent
   *   genuinely needs the sub-agent's verbatim output (structured data
   *   extraction, a single close-coupled delegation) — not as the default
   *   posture for fan-out.
   */
  returnMode?: 'summary' | 'full';
  /**
   * Condenses the sub-agent's `SuccessfulRunResult` into the string returned
   * to the parent when `returnMode` is `'summary'`. Defaults to
   * `defaultSubagentSummarizer` (character-based truncation). Ignored when
   * `returnMode` is `'full'`.
   */
  summarizer?: SubagentSummarizer<TOutput, THasOutput>;
  /**
   * Token budget for the summary returned to the parent when `returnMode`
   * is `'summary'`. Defaults to `500`. Ignored when `returnMode` is
   * `'full'`.
   */
  summaryTokenCap?: number;
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
  /**
   * Wraps the child's `agent.run()` call in the parent's own trace context
   * (AB-19), exactly as `RunOptions.withTraceContext` wraps generate/tool
   * calls within a run. Passed straight through to
   * `agent.run(input, { withTraceContext, ... })` — supplied here, rather
   * than read off the parent tool call's `ToolContext` (which carries no
   * such callback), because it is a per-run wrapper, not per-call data.
   */
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Creates a tool that delegates execution to a sub-agent.
 *
 * F1: When `parentContext` is supplied the tool emits a `ChildWorkflowStartedEvent`
 * on every execution, exposing the multi-agent delegation transition as an
 * observable event (C3 completeness rule — every state transition emits an event
 * and exposes a hook).
 */
export function createSubagentTool<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  THasOutput extends boolean = boolean,
  TToolOutput = string,
>(options: CreateSubagentToolOptions<TInput, TOutput, THasOutput, TToolOutput>) {
  const {
    name,
    description,
    agent,
    agentName,
    input,
    // `TInput extends object`, so `parsed` is never itself a string — this
    // intentionally reproduces the pre-AB-19 default's `String(params)`
    // fallback (documented above), which for a plain object degrades to
    // `"[object Object]"`. A caller who wants a real projection supplies
    // `toAgentInput`; this default exists only so the option can be omitted.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    toAgentInput = (parsed: TInput): AgentInput => String(parsed),
    // `TToolOutput` defaults to `string` (see `CreateSubagentToolOptions`),
    // making this default genuinely correct at its one call site — a
    // caller who omits `toToolOutput` gets `TToolOutput = string`. The
    // cast is still required here because this default is written once,
    // generically, before any particular call site has pinned `TToolOutput`
    // to `string`; TypeScript can't see that the omitted-option branch and
    // the `string` default coincide.
    toToolOutput = (result: SuccessfulRunResult<TOutput, THasOutput>) =>
      result.content as unknown as TToolOutput,
    returnMode = 'summary',
    // `defaultSubagentSummarizer` only ever reads `.content` — a field
    // `RunResultBase` (and therefore every `SuccessfulRunResult<O, H>`
    // regardless of `O`/`H`) always carries — so it is genuinely safe for
    // any instantiation, and TypeScript itself accepts the assignment with
    // no cast (an unparameterized `SuccessfulRunResult`'s `[boolean] extends
    // [true]` check resolves to the no-`output` branch, which every
    // `SuccessfulRunResult<TOutput, THasOutput>` structurally satisfies).
    summarizer = defaultSubagentSummarizer,
    summaryTokenCap = 500,
    parentContext,
    withTraceContext,
  } = options;

  return createTool({
    name,
    description,
    input,
    execute: async (params: TInput, context: ToolContext) => {
      const agentInput = toAgentInput(params);

      // F1 — emit ChildWorkflowStartedEvent before the child run begins.
      // `ChildWorkflowStartedEvent.input` is (and stays, per this issue's
      // "preserve child-start events" criterion) a plain string — a
      // conversation-history `agentInput` is projected to a named, lossy
      // marker rather than widening the event's field.
      if (parentContext) {
        parentContext.emitter.dispatchEvent(
          new ChildWorkflowStartedEvent({
            parentAgentName: parentContext.parentAgentName,
            parentRunId: parentContext.parentRunId,
            childAgentName: agentName,
            input: typeof agentInput === 'string' ? agentInput : '[conversation history]',
            durable: parentContext.durable,
          }),
        );
      }

      const childRun = agent.run(agentInput, {
        agentName,
        signal: context.signal,
        traceContext: context.traceContext,
        withTraceContext,
      });
      const result = await childRun.result();

      // Every non-success terminal (abort, execution error, tripwire,
      // budget exceeded, elicitation denied, maximum steps, or a clean stop
      // whose output failed schema validation) rejects here — `toToolOutput`
      // is never invoked with anything but a clean, schema-valid success.
      if (!isSuccessfulRunResult(result)) {
        throw new SubagentRunError(agentName, result);
      }

      if (returnMode === 'full') {
        return toToolOutput(result);
      }

      // AB-64 — condense the sub-agent's context down to a capped summary
      // before it crosses back into the parent. Only `content` is replaced;
      // `toToolOutput` still receives the rest of the `RunResult` untouched.
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
      // `result` is already `SuccessfulRunResult<TOutput, THasOutput>` (the
      // `isSuccessfulRunResult` guard above narrowed it); this spread only
      // reassigns `content`, a `string` field present on both sides. The
      // cast is needed because `THasOutput`/`TOutput` are still unresolved
      // generics here, so TypeScript can't algebraically prove the fresh
      // spread's conditional-intersection shape equals the (differently
      // arranged) conditional-intersection shape it started from, even
      // though the runtime object is structurally identical to `result`
      // apart from `content`.
      return toToolOutput({
        ...result,
        content: cappedContent,
      } as SuccessfulRunResult<TOutput, THasOutput>);
    },
  });
}
