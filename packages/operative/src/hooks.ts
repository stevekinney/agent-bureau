import type { Toolbox, ToolExecutionResult } from 'armorer';
import type { Message } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { HookMap } from 'lifecycle';

import type { AgentSession } from './agent-session';
import type { BudgetReport, TokenBudget } from './context/index';
import type {
  AfterGenerateContext,
  BeforeGenerateContext,
  ErrorContext,
  ErrorRecoveryAction,
  LLMInputContext,
  LLMOutputContext,
  RunAbortContext,
  RunCompleteContext,
  RunErrorContext,
  RunStartContext,
} from './hooks/types';
import type { ToolChoice } from './structured-output/types';
import type {
  GenerateContext,
  GenerateResponse,
  StepContext,
  StepResult,
  ToolExecutionHookContext,
  ToolExecutionResultContext,
} from './types';

/** Context passed to beforeContextAssembly hooks. */
export interface ContextAssemblyHookContext {
  conversation: StepContext['conversation'];
  step: number;
  budget: TokenBudget;
}

/** Context passed to afterContextAssembly hooks. */
export interface AfterContextAssemblyHookContext {
  conversation: StepContext['conversation'];
  step: number;
  messages: ReadonlyArray<Message>;
  budgetReport: BudgetReport;
}

/** Context passed to beforeCompaction hooks. */
export interface BeforeCompactionHookContext {
  conversation: StepContext['conversation'];
  step: number;
  budget: TokenBudget;
}

/** Stats provided to afterCompaction hooks. */
export interface AfterCompactionHookContext {
  conversation: StepContext['conversation'];
  step: number;
  messagesRemoved: number;
  tokensFreed: number;
}

export interface OperativeHookMap extends HookMap {
  prepareStep: (context: StepContext) => Promise<void | GenerateResponse>;
  beforeToolExecution: (context: ToolExecutionHookContext) => Promise<ToolCall[]>;
  afterToolExecution: (context: ToolExecutionResultContext) => Promise<void>;
  onStep: (result: StepResult) => Promise<void>;
  selectTools: (context: StepContext) => Promise<Toolbox>;
  validateResponse: (
    response: GenerateResponse,
    context: StepContext,
  ) => Promise<GenerateResponse | void>;
  validateToolResult: (
    result: ToolExecutionResult,
    context: ToolExecutionResultContext,
  ) => Promise<ToolExecutionResult | void>;
  onSessionCreate: (session: AgentSession) => Promise<void>;
  onSessionSave: (session: AgentSession) => Promise<void>;
  onSessionLoad: (session: AgentSession) => Promise<void>;
  onSessionDelete: (id: string) => Promise<void>;
  /** Runs before context assembly. Can inject messages or modify the budget. */
  beforeContextAssembly: (context: ContextAssemblyHookContext) => Promise<void>;
  /** Runs after context assembly. Read-only monitoring of assembled messages and budget report. */
  afterContextAssembly: (context: AfterContextAssemblyHookContext) => Promise<void>;
  /** Runs before compaction. Return `false` to cancel compaction. */
  beforeCompaction: (context: BeforeCompactionHookContext) => Promise<boolean | void>;
  /** Runs after compaction with stats about what was removed. */
  afterCompaction: (context: AfterCompactionHookContext) => Promise<void>;
  selectToolChoice: (context: StepContext) => Promise<ToolChoice | void>;
  /** Called before the generate call. Can modify the generate context (waterfall). */
  beforeGenerate: (context: BeforeGenerateContext) => Promise<GenerateContext | void>;
  /** Called after the generate call. Can modify the response (waterfall). */
  afterGenerate: (context: AfterGenerateContext) => Promise<GenerateResponse | void>;
  /** Read-only monitoring hook for LLM input. Runs in parallel, non-blocking. */
  onLLMInput: (context: LLMInputContext) => Promise<void>;
  /** Read-only monitoring hook for LLM output. Runs in parallel, non-blocking. */
  onLLMOutput: (context: LLMOutputContext) => Promise<void>;
  /** Called when a run starts, before the first step. */
  onRunStart: (context: RunStartContext) => Promise<void>;
  /** Called when a run completes successfully. */
  onRunComplete: (context: RunCompleteContext) => Promise<void>;
  /** Called when a run errors, with the error and partial results. */
  onRunError: (context: RunErrorContext) => Promise<void>;
  /** Called when a run is aborted. */
  onRunAbort: (context: RunAbortContext) => Promise<void>;
  /** Error recovery hook. Return 'retry', 'skip', or 'abort' to control behavior. */
  onError: (context: ErrorContext) => Promise<ErrorRecoveryAction | void>;
}
