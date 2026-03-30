import type { Toolbox } from 'armorer';
import type { Conversation } from 'conversationalist';

import type { GenerateResponse, RunResult, StepResult, TokenUsage } from '../types';

/** Context passed to beforeGenerate hooks. */
export interface BeforeGenerateContext {
  conversation: Conversation;
  step: number;
  toolbox: Toolbox;
  signal?: AbortSignal;
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
  toolbox: Toolbox;
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
