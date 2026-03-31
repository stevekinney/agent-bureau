import type { Toolbox, ToolExecuteOptions, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationHistory, TokenUsage } from 'conversationalist';
import type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';
import type { HookRegistry } from 'lifecycle';
import type { KeyValueStore } from 'storage';
import type { ZodType } from 'zod';

import type { AgentSession } from './agent-session';
import type { BackpressureStrategy } from './backpressure';
import type { ActiveRun } from './create-run';
import type { OperativeHookMap } from './hooks';
import type { RetryMutator } from './retry/types';
import type { ResponseFormat, ToolChoice } from './structured-output/types';

export type { Toolbox, ToolExecuteOptions, ToolExecutionResult } from 'armorer';
export type { TokenUsage } from 'conversationalist';
export type { Conversation, ConversationHistory } from 'conversationalist';
export type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';

/**
 * Options passed to toolbox.execute() within the loop.
 */
export interface OperativeExecuteOptions extends ToolExecuteOptions {
  concurrency?: number;
  mode?: 'parallel' | 'sequential';
  errorMode?: 'failFast' | 'collect';
}

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
  | 'budget-exceeded';

/**
 * Context passed to the user-provided generate function.
 */
export interface GenerateContext {
  conversation: Conversation;
  step: number;
  signal?: AbortSignal;
  toolbox: Toolbox;
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
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
export type SelectToolsHook = (context: StepContext) => Promise<Toolbox> | Toolbox;
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
export interface RunResult {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage;
  finishReason: FinishReason;
  error?: unknown;
  schemaValidation?: { success: boolean; error?: unknown };
}

/**
 * Options for the run() and createRun() entry points.
 */
export interface RunOptions {
  generate: GenerateFunction;
  toolbox: Toolbox;
  conversation: Conversation | ConversationHistory;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
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
  responseSchema?: ZodType;
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
}

/**
 * Context for streaming generate functions.
 */
export interface StreamingHandle {
  update: (content: string) => void;
  messageId: string;
}

/**
 * A generate function that supports streaming.
 */
export type StreamingGenerateFunction = (
  context: GenerateContext & { streaming: StreamingHandle },
) => Promise<GenerateResponse>;

/**
 * Options for defining a reusable agent configuration.
 */
interface Renderable {
  render(options?: Record<string, unknown>): string;
}

export interface DefineAgentOptions {
  name: string;
  instructions?: string | Renderable;
  generate: GenerateFunction;
  toolbox: Toolbox;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  prepareStep?: RunOptions['prepareStep'];
  beforeToolExecution?: RunOptions['beforeToolExecution'];
  afterToolExecution?: RunOptions['afterToolExecution'];
  onStep?: RunOptions['onStep'];
  retry?: RetryOptions;
  validateResponse?: RunOptions['validateResponse'];
  validateToolResult?: RunOptions['validateToolResult'];
  selectTools?: RunOptions['selectTools'];
  onElicitation?: RunOptions['onElicitation'];
  hooks?: RunOptions['hooks'];
  contextManagement?: ContextManagementOptions;
  responseSchema?: RunOptions['responseSchema'];
  schemaRetries?: RunOptions['schemaRetries'];
  schemaRetryMessage?: RunOptions['schemaRetryMessage'];
  onMaximumSteps?: RunOptions['onMaximumSteps'];
  executeOptions?: OperativeExecuteOptions;
  collectAsync?: boolean;
  withTraceContext?: RunOptions['withTraceContext'];
  persistence?: KeyValueStore;
  sessionId?: string;
  onSessionSave?: (session: AgentSession) => Promise<void> | void;
  onSessionLoad?: (session: AgentSession) => Promise<void> | void;
  autoSave?: 'step' | 'completion' | false;
}

/**
 * Options for running a defined agent.
 */
export interface AgentRunOptions {
  conversation?: Conversation | ConversationHistory | string;
  signal?: AbortSignal;
  stopWhen?: StopCondition | StopCondition[];
  parentContext?: unknown;
  hooks?: HookRegistry<OperativeHookMap>;
}

/**
 * A reusable agent definition returned by defineAgent().
 */
export interface AgentDefinition {
  readonly name: string;
  readonly options: Readonly<DefineAgentOptions>;
  run(input: string | AgentRunOptions): Promise<RunResult>;
  createRun(input: string | AgentRunOptions): ActiveRun;
}

/**
 * Options for creating a subagent tool.
 */
export interface CreateSubagentToolOptions {
  name: string;
  description: string;
  agent: AgentDefinition;
  input: ZodType;
  mapInput?: (input: unknown) => string | AgentRunOptions;
  mapOutput?: (result: RunResult) => unknown;
  /**
   * When true (the default), a sub-agent finishing with `maximum-steps` is
   * treated as an error and throws. Set to false to accept partial results.
   */
  treatMaximumStepsAsError?: boolean;
}
