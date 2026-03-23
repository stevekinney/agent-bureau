import type { Toolbox, ToolExecuteOptions, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationHistory, TokenUsage } from 'conversationalist';
import type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';
import type { ZodType } from 'zod';

import type { ActiveRun } from './create-run';

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
}

/**
 * Options for automatic context window management.
 */
export interface ContextManagementOptions {
  maxTokens: number;
  onCompact: (conversation: Conversation, context: StepContext) => Promise<void>;
  tokenEstimator?: (conversation: Conversation) => number;
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
 * Result of a single step in the agent loop.
 */
export interface StepResult {
  step: number;
  conversation: Conversation;
  content: string;
  toolCalls: readonly ToolCall[];
  results: readonly ToolExecutionResult[];
  usage?: TokenUsage;
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
  prepareStep?: (context: StepContext) => Promise<void | GenerateResponse>;
  beforeToolExecution?: (context: ToolExecutionHookContext) => Promise<ToolCall[]>;
  afterToolExecution?: (context: ToolExecutionResultContext) => Promise<void>;
  onStep?: (context: StepResult) => Promise<void>;
  executeOptions?: OperativeExecuteOptions;
  signal?: AbortSignal;
  /**
   * When true, tool results that resolve to promises are awaited and their
   * resolved values are appended to the conversation. Useful when tools return
   * deferred results like streaming content.
   */
  collectAsync?: boolean;
  retry?: RetryOptions;
  validateResponse?: (
    response: GenerateResponse,
    context: StepContext,
  ) => Promise<GenerateResponse | void>;
  validateToolResult?: (
    result: ToolExecutionResult,
    context: ToolExecutionResultContext,
  ) => Promise<ToolExecutionResult | void>;
  /**
   * Called before each step to dynamically select which tools are available.
   * Return a filtered or entirely different toolbox to control which tools
   * the model can call on a per-step basis.
   */
  selectTools?: (context: StepContext) => Promise<Toolbox> | Toolbox;
  onElicitation?: OnElicitation;
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
  contextManagement?: ContextManagementOptions;
  responseSchema?: RunOptions['responseSchema'];
  schemaRetries?: RunOptions['schemaRetries'];
  schemaRetryMessage?: RunOptions['schemaRetryMessage'];
  onMaximumSteps?: RunOptions['onMaximumSteps'];
  executeOptions?: OperativeExecuteOptions;
  collectAsync?: boolean;
  withTraceContext?: RunOptions['withTraceContext'];
}

/**
 * Options for running a defined agent.
 */
export interface AgentRunOptions {
  conversation?: Conversation | ConversationHistory | string;
  signal?: AbortSignal;
  stopWhen?: StopCondition | StopCondition[];
  parentContext?: unknown;
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
