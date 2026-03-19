import type { ToolExecuteOptions, ToolExecutionResult, Toolbox } from 'armorer';
import type { Conversation, ConversationHistory, TokenUsage } from 'conversationalist';
import type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';

export type { TokenUsage } from 'conversationalist';
export type { JSONValue, ToolCall, ToolCallInput } from 'interoperability';
export type { ToolExecuteOptions, ToolExecutionResult, Toolbox } from 'armorer';
export type { Conversation, ConversationHistory } from 'conversationalist';

/**
 * Options passed to toolbox.execute() within the loop.
 */
export interface OperativeExecuteOptions extends ToolExecuteOptions {
  concurrency?: number;
  mode?: 'parallel' | 'sequential';
  errorMode?: 'failFast' | 'collect';
}

/**
 * Finish reasons for the agent loop.
 */
export type FinishReason = 'stop-condition' | 'maximum-steps' | 'aborted' | 'error';

/**
 * Context passed to the user-provided generate function.
 */
export interface GenerateContext {
  conversation: Conversation;
  step: number;
  signal?: AbortSignal;
}

/**
 * Response returned by the user-provided generate function.
 */
export interface GenerateResponse {
  content: string;
  toolCalls: ToolCallInput[];
  usage?: TokenUsage;
  metadata?: Record<string, JSONValue>;
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
}

/**
 * Context passed to the beforeToolExecution hook.
 */
export interface ToolExecutionHookContext {
  conversation: Conversation;
  step: number;
  toolCalls: ToolCall[];
}

/**
 * Context passed to the afterToolExecution hook.
 */
export interface ToolExecutionResultContext {
  conversation: Conversation;
  step: number;
  toolCalls: readonly ToolCall[];
  results: readonly ToolExecutionResult[];
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
  collectAsync?: boolean;
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
