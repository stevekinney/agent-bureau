import type { AnyToolbox, ToolExecuteOptions, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationHistory, TokenUsage } from 'conversationalist';
import type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';
import type { HookRegistry } from 'lifecycle';
import type { ZodType } from 'zod';

import type { BackpressureStrategy } from './backpressure';
import type { CostEstimate, CostEstimationOptions } from './cost-estimation';
import type { OperativeHookMap } from './hooks';
import type { RetryMutator } from './retry/types';
import type { LiveStreamEvent } from './streaming/types';
import type { ResponseFormat, ToolChoice } from './structured-output/types';

export type { AnyToolbox, Toolbox, ToolExecuteOptions, ToolExecutionResult } from 'armorer';
export type { Conversation, ConversationHistory, TokenUsage } from 'conversationalist';
export type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';

/**
 * Options passed to toolbox.execute() within the loop.
 */
export type OperativeExecuteOptions = Omit<ToolExecuteOptions, 'durableOperationKey'> & {
  concurrency?: number;
  mode?: 'parallel' | 'sequential';
  errorMode?: 'failFast' | 'collect';
  durableOperationKey?: string | ((call: ToolCall, index: number) => string | undefined);
};

export interface ElicitationRequest<T = unknown> {
  message: string;
  schema: ZodType<T>;
  context: StepContext;
}

export type ElicitationResponse<T = unknown> = { data: T } | null;

export type OnElicitation = <T>(request: ElicitationRequest<T>) => Promise<ElicitationResponse<T>>;

/**
 * Options for retrying the generate call on transient failures.
 */
export interface RetryOptions {
  attempts: number;
  delay?: number | ((attempt: number) => number);
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Transforms the generate context before a retry attempt. */
  mutate?: RetryMutator;
  /** Injectable sleep used between retry attempts. Defaults to a setTimeout-backed delay. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Whether to add random jitter to the retry delay. Defaults to false. */
  jitter?: boolean;
  /** Maximum jitter offset in milliseconds. Defaults to half the delay. */
  maxJitter?: number;
}

/**
 * Options for automatic context window management.
 */
export interface ContextManagementOptions {
  maxTokens: number;
  onCompact: (conversation: Conversation, context: StepContext) => Promise<void>;
  tokenEstimator?: (conversation: Conversation) => number;
  /** Minimum tokens reserved for the model response. Default: `1500`. */
  minimumResponseTokens?: number;
  /** Warning when remaining tokens drop to this level. Default: 20% of `maxTokens`. */
  warningThreshold?: number;
  /** Compaction triggered when used tokens reach this level. Default: 80% of `maxTokens`. */
  compactionThreshold?: number;
}

/**
 * Finish reasons for the agent loop.
 */
export type FinishReason =
  | 'stop-condition'
  | 'maximum-steps'
  | 'aborted'
  | 'error'
  | 'elicitation-denied'
  | 'budget-exceeded'
  | 'tripwire';

/**
 * Context passed to the user-provided generate function.
 */
export interface GenerateContext {
  conversation: Conversation;
  step: number;
  signal?: AbortSignal;
  toolbox: AnyToolbox;
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /**
   * Per-request output token cap; overrides the provider's construction-time
   * maximumTokens for this call.
   */
  maximumTokens?: number;
}

/**
 * Response returned by the user-provided generate function.
 */
export interface GenerateResponse {
  content: string;
  toolCalls: ToolCallInput[];
  usage?: TokenUsage;
  metadata?: Record<string, JSONValue>;
  /**
   * When true, the generate function has already appended the assistant message
   * to the conversation (e.g. via streaming finalization). The loop will skip
   * its own `appendAssistantMessage` call to avoid duplicates.
   */
  messageAppended?: boolean;
}

/**
 * The user-provided function that calls the LLM.
 */
export type GenerateFunction = (context: GenerateContext) => Promise<GenerateResponse>;

/**
 * Wraps a GenerateFunction, returning a new GenerateFunction.
 */
export type GenerateMiddleware = (next: GenerateFunction) => GenerateFunction;

/**
 * Result of a single step in the agent loop.
 */
export interface StepResult {
  step: number;
  conversation: Conversation;
  content: string;
  toolCalls: readonly ToolCall[];
  results: readonly ToolExecutionResult[];
  usage?: TokenUsage;
  metadata?: Record<string, JSONValue>;
  final: boolean;
}

/**
 * Context passed to the prepareStep hook.
 */
export interface StepContext {
  conversation: Conversation;
  step: number;
  signal?: AbortSignal;
  abortStep?: (reason?: string) => void;
  elicit?: <T>(message: string, schema: ZodType<T>) => Promise<T | null>;
}

/**
 * Context passed to the beforeToolExecution hook.
 */
export interface ToolExecutionHookContext {
  conversation: Conversation;
  step: number;
  toolCalls: ToolCall[];
  elicit?: <T>(message: string, schema: ZodType<T>) => Promise<T | null>;
}

/**
 * Context passed to the afterToolExecution hook.
 */
export interface ToolExecutionResultContext {
  conversation: Conversation;
  step: number;
  toolCalls: readonly ToolCall[];
  results: readonly ToolExecutionResult[];
  elicit?: <T>(message: string, schema: ZodType<T>) => Promise<T | null>;
}

/**
 * Named hook type aliases for composable hook arrays.
 */
export type PrepareStepHook = (context: StepContext) => Promise<void | GenerateResponse>;
export type BeforeToolExecutionHook = (context: ToolExecutionHookContext) => Promise<ToolCall[]>;
export type AfterToolExecutionHook = (context: ToolExecutionResultContext) => Promise<void>;
export type OnStepHook = (context: StepResult) => Promise<void>;
export type SelectToolsHook = (context: StepContext) => Promise<AnyToolbox> | AnyToolbox;
export type ValidateResponseHook = (
  response: GenerateResponse,
  context: StepContext,
) => Promise<GenerateResponse | void>;
export type ValidateToolResultHook = (
  result: ToolExecutionResult,
  context: ToolExecutionResultContext,
) => Promise<ToolExecutionResult | void>;

/** Hook called before the LLM generate call. Can modify the generate context. */
export type BeforeGenerateHook = OperativeHookMap['beforeGenerate'];
/** Hook called after the LLM generate call. Can modify the response. */
export type AfterGenerateHook = OperativeHookMap['afterGenerate'];
/** Read-only monitoring hook for LLM input. */
export type OnLLMInputHook = OperativeHookMap['onLLMInput'];
/** Read-only monitoring hook for LLM output. */
export type OnLLMOutputHook = OperativeHookMap['onLLMOutput'];
/** Hook called when a run starts. */
export type OnRunStartHook = OperativeHookMap['onRunStart'];
/** Hook called when a run completes successfully. */
export type OnRunCompleteHook = OperativeHookMap['onRunComplete'];
/** Hook called when a run errors. */
export type OnRunErrorHook = OperativeHookMap['onRunError'];
/** Hook called when a run is aborted. */
export type OnRunAbortHook = OperativeHookMap['onRunAbort'];
/** Error recovery hook. Returns an action to control recovery behavior. */
export type OnErrorHook = OperativeHookMap['onError'];

/**
 * A predicate that determines whether the loop should stop.
 */
export type StopCondition = (context: StepResult) => boolean | Promise<boolean>;

/**
 * Result of a completed agent loop run.
 */
export interface RunResultBase {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage;
  /**
   * Cost estimate for `usage`, computed from `RunOptions.costEstimation` when
   * provided. Present on every terminal result — stop-condition, maximum-steps,
   * abort, and error alike — so a budget-triggered or errored run still
   * reports what it spent. Absent (never `0`) when `costEstimation` wasn't
   * supplied or its model has no resolvable pricing.
   *
   * This is an in-loop budgeting estimate, not a billing figure — see
   * {@link estimateCost}'s doc comment.
   */
  costEstimate?: CostEstimate;
  finishReason: FinishReason;
  error?: unknown;
  schemaValidation?: { success: boolean; error?: unknown };
  /**
   * The `output`-schema-validated structured output (AB-18), present when
   * the run stopped after an `output` Zod schema was applied AND validation
   * succeeded (`schemaValidation.success === true`). Distinct from `content`
   * (the raw model text) — this is the Zod-parsed value. Absent when
   * there's no `output` schema, or when validation failed.
   */
}

/**
 * Terminal result. The validated value is exposed under `output`; the
 * conditional intersection keeps the property out of untyped (`H = false`)
 * results while retaining the historical, unparameterized internal shape.
 */
export type RunResult<O = unknown, H extends boolean = true> = RunResultBase &
  ([H] extends [true] ? { output?: O } : Record<never, never>);

/**
 * Options for the agent loop.
 */
export interface RunOptions {
  generate: GenerateFunction;
  toolbox: AnyToolbox;
  conversation: Conversation | ConversationHistory;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  /**
   * Per-request output token cap; overrides the provider's construction-time
   * maximumTokens for this call.
   */
  maximumTokens?: number;
  prepareStep?: PrepareStepHook | PrepareStepHook[];
  beforeToolExecution?: BeforeToolExecutionHook | BeforeToolExecutionHook[];
  afterToolExecution?: AfterToolExecutionHook | AfterToolExecutionHook[];
  onStep?: OnStepHook | OnStepHook[];
  executeOptions?: OperativeExecuteOptions;
  signal?: AbortSignal;
  /**
   * When true, tool results that resolve to promises are awaited and their
   * resolved values are appended to the conversation. Useful when tools return
   * deferred results like streaming content.
   */
  collectAsync?: boolean;
  retry?: RetryOptions;
  /**
   * Backpressure strategy applied before each step. When set, the loop
   * calls `backpressure.beforeStep()` and waits for the returned delay
   * before proceeding with the generate call.
   */
  backpressure?: BackpressureStrategy;
  validateResponse?: ValidateResponseHook | ValidateResponseHook[];
  validateToolResult?: ValidateToolResultHook | ValidateToolResultHook[];
  /**
   * Called before each step to dynamically select which tools are available.
   * Return a filtered or entirely different toolbox to control which tools
   * the model can call on a per-step basis.
   */
  selectTools?: SelectToolsHook | SelectToolsHook[];
  onElicitation?: OnElicitation;
  /**
   * A typed HookRegistry for structured hook registration with priority
   * ordering. Runs in addition to any old-style hook arrays.
   */
  hooks?: HookRegistry<OperativeHookMap>;
  contextManagement?: ContextManagementOptions;
  /**
   * The Zod schema the final response must satisfy (AB-18) — the single
   * validated output contract. Validated with `.parseAsync()`; its
   * provider-native JSON Schema is derived automatically via
   * `z.toJSONSchema(schema, { io: 'input' })`. There is no raw JSON Schema
   * input and no non-Zod Standard Schema branch — see
   * `structured-output/response-schema.ts`.
   *
   * An `output` schema MUST NOT declare a field intended to carry binary or
   * media content (AB-70's amendment to this issue): a generated asset a
   * run produces belongs in `RunResult.parts` as a managed-asset reference
   * part, never inlined as base64 inside the schema-validated `output`.
   */
  output?: ZodType<unknown>;
  schemaRetries?: number;
  /**
   * Custom message factory for schema validation retries. Called when the
   * response fails schema validation and retries remain. The returned string
   * is appended as a user message to prompt correction.
   *
   * Defaults to a generic message containing the validation error.
   */
  schemaRetryMessage?: (error: unknown, attempt: number) => string;
  /**
   * Called when the loop exits due to reaching `maximumSteps`. If this
   * returns a string, it replaces the final content (e.g. a forced summary
   * from one last LLM call without tools). The `finishReason` remains
   * `'maximum-steps'` regardless.
   */
  onMaximumSteps?: (context: StepContext) => Promise<string | void>;
  /**
   * Opaque parent trace context (e.g. an OpenTelemetry Context) passed from
   * a parent agent. Used with `withTraceContext` to nest child spans under the
   * parent's trace.
   */
  parentContext?: unknown;

  /**
   * Agent name, used to stamp curated `tool.*` bubble events with
   * `{agentName, runId, step}` metadata. Optional — only supplied when
   * running inside a named agent (bureau.agent / createAgent).
   */
  agentName?: string;

  /**
   * Run id, used to stamp curated `tool.*` bubble events. Optional — only
   * supplied when the run has a stable identity (session-owned runs).
   */
  runId?: string;
  /**
   * Enables replay-safe durable operation keys for tool calls. This is distinct
   * from `runId`, because in-memory session-owned runs also have stable run ids
   * for event stamping but should not make effectful tools idempotent.
   *
   * @internal
   */
  durableOperationKeys?: boolean;
  /**
   * Callback that runs a function within a parent trace context. When both
   * `parentContext` and `withTraceContext` are provided, the loop wraps
   * generate and tool-execution calls so child spans nest correctly.
   *
   * This keeps operative free of any `@opentelemetry/api` dependency.
   */
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  /**
   * Default tool choice constraint applied to every step unless overridden
   * by the `selectToolChoice` hook.
   */
  toolChoice?: ToolChoice;
  /**
   * When set, every terminal `RunResult` (stop-condition, maximum-steps,
   * abort, or error) carries a `costEstimate` computed from the run's
   * accumulated `usage` at this model's pricing. `pricing` overrides
   * `defaultPricingTable` the same way `estimateCost`'s options do. Omit to
   * leave `costEstimate` absent — no estimate is fabricated without an
   * explicit model.
   */
  costEstimation?: { model: string; pricing?: CostEstimationOptions };
}

/**
 * Context for streaming generate functions.
 */
export interface StreamingHandle {
  update: (content: string) => void;
  messageId: string;
  /**
   * Live channel for structured events the text-only `update` cannot carry.
   *
   * A `StreamingGenerateFunction` calls this the moment the provider reports a
   * tool call, so a wrapper can surface `stream:tool-call-start` and
   * `stream:tool-call-delta` while the response is still open rather than
   * reconstructing them from the resolved `GenerateResponse`.
   *
   * Optional on both sides: a wrapper installs it only when it wants live
   * events (`withEnhancedStreaming`'s `liveToolCalls` option), and an adapter
   * calls it as `streaming.report?.(...)`, so neither half has to know whether
   * the other opted in.
   */
  report?: (event: LiveStreamEvent) => void;
}

/**
 * A generate function that supports streaming.
 */
export type StreamingGenerateFunction = (
  context: GenerateContext & { streaming: StreamingHandle },
) => Promise<GenerateResponse>;
