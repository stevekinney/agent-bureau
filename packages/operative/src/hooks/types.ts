import type { AnyToolbox } from 'armorer';
import type { Conversation } from 'conversationalist';

import type { SteeringDesiredState } from '../durable/types';
import type { AgentRunError } from '../errors';
import type { ResponseFormat, ToolChoice } from '../structured-output/types';
import type { GenerateResponse, RunResult, StepResult, TokenUsage } from '../types';

/**
 * Context passed to beforeGenerate hooks.
 *
 * `steering` is read-only here: it carries the session's desired steering
 * state (AB-67) as of this step's boundary read, for a hook that wants to
 * react to it. It is NOT hook-overridable — if this hook returns a
 * replacement `GenerateContext`, `runStep` re-applies its own boundary-read
 * `steering` value onto the replacement afterward, so a hook can never
 * silently drop or override the session's desired steering state.
 */
export interface BeforeGenerateContext {
  conversation: Conversation;
  step: number;
  toolbox: AnyToolbox;
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  steering?: SteeringDesiredState;
}

/** Context passed to afterGenerate hooks. */
export interface AfterGenerateContext {
  conversation: Conversation;
  step: number;
  response: GenerateResponse;
  duration: number;
}

/** Context passed to onLLMInput hooks. */
export interface LLMInputContext {
  conversation: Conversation;
  step: number;
  messageCount: number;
  estimatedTokens?: number;
}

/** Context passed to onLLMOutput hooks. */
export interface LLMOutputContext {
  conversation: Conversation;
  step: number;
  response: Readonly<GenerateResponse>;
  duration: number;
  usage?: TokenUsage;
}

/** Context passed to onRunStart hooks. */
export interface RunStartContext {
  conversation: Conversation;
  toolbox: AnyToolbox;
  maximumSteps: number;
}

/** Context passed to onRunComplete hooks. */
export interface RunCompleteContext {
  result: RunResult;
  totalDuration: number;
}

/** Context passed to onRunError hooks. */
export interface RunErrorContext {
  error: unknown;
  partialSteps: ReadonlyArray<StepResult>;
  conversation: Conversation;
}

/** Context passed to onRunAbort hooks. */
export interface RunAbortContext {
  reason?: string;
  error: AgentRunError;
  partialSteps: ReadonlyArray<StepResult>;
  conversation: Conversation;
}

/** Action returned by an onError hook to control error recovery. */
export type ErrorRecoveryAction = 'retry' | 'skip' | 'abort';

/** Context passed to onError hooks. */
export interface ErrorContext {
  error: unknown;
  step: number;
  phase: 'generate' | 'tool-execution';
  conversation: Conversation;
  retryCount: number;
  maxRetries: number;
}
