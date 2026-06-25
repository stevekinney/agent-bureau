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

// ---------------------------------------------------------------------------
// Hook context types for curated tool.* bubble events (C3)
// ---------------------------------------------------------------------------

/** Context passed to onToolStarted hooks. */
export interface ToolStartedHookContext {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly params: unknown;
  readonly startedAt: number;
}

/** Context passed to onToolSettled hooks. */
export interface ToolSettledHookContext {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
  readonly durationMs?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Context passed to onToolError hooks. */
export interface ToolErrorHookContext {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly error: unknown;
}

/** Context passed to onToolProgress hooks. */
export interface ToolProgressHookContext {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly percent?: number;
  readonly message?: string;
}

/** Context passed to onToolPolicyDenied hooks. */
export interface ToolPolicyDeniedHookContext {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Hook context types for session verb events (C3 completeness rule)
// ---------------------------------------------------------------------------

/** Context passed to onSessionRecover hooks. */
export interface SessionRecoverHookContext {
  readonly sessionId: string;
  readonly runId: string | null;
}

/** Context passed to onSessionCancel hooks. */
export interface SessionCancelHookContext {
  readonly sessionId: string;
  readonly runId: string | null;
}

/** Context passed to onSessionFork hooks. */
export interface SessionForkHookContext {
  readonly sourceSessionId: string;
  readonly forkedSessionId: string;
  readonly throughRun?: number;
}

/** Context passed to onSessionSleep hooks. */
export interface SessionSleepHookContext {
  readonly sessionId: string;
  readonly durationMs: number;
}

/** Context passed to onSessionSignal hooks. */
export interface SessionSignalHookContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly signalName: string;
  readonly payload: unknown;
}

/** Context passed to onSessionUpdate hooks. */
export interface SessionUpdateHookContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly updateName: string;
  readonly payload: unknown;
}

/** Context passed to onSessionQuery hooks. */
export interface SessionQueryHookContext {
  readonly sessionId: string;
  readonly queryName: string;
  readonly input: unknown;
}

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
  // -------------------------------------------------------------------------
  // Curated tool.* bubble event hooks (C3) — read-only monitoring, run in
  // parallel, non-blocking. Carry {agentName, runId, step} stamp.
  // -------------------------------------------------------------------------
  /** Called when a tool call begins executing. Read-only, non-blocking. */
  onToolStarted: (context: ToolStartedHookContext) => Promise<void>;
  /** Called when a tool call settles (success, error, denied, cancelled, paused). Read-only, non-blocking. */
  onToolSettled: (context: ToolSettledHookContext) => Promise<void>;
  /** Called when a tool call errors. Read-only, non-blocking. */
  onToolError: (context: ToolErrorHookContext) => Promise<void>;
  /** Called when a tool reports progress. Read-only, non-blocking. */
  onToolProgress: (context: ToolProgressHookContext) => Promise<void>;
  /** Called when a tool call is denied by policy. Read-only, non-blocking. */
  onToolPolicyDenied: (context: ToolPolicyDeniedHookContext) => Promise<void>;
  // -------------------------------------------------------------------------
  // Session verb hooks (C3 completeness rule) — every new state transition
  // exposes a hook. Multi-agent transitions land in Phase F.
  // -------------------------------------------------------------------------
  /** Called when session.recover() is invoked. Read-only, non-blocking. */
  onSessionRecover: (context: SessionRecoverHookContext) => Promise<void>;
  /** Called when session.cancel() is invoked. Read-only, non-blocking. */
  onSessionCancel: (context: SessionCancelHookContext) => Promise<void>;
  /** Called when session.fork() completes and the forked session is persisted. Read-only, non-blocking. */
  onSessionFork: (context: SessionForkHookContext) => Promise<void>;
  /** Called when session.sleep() is invoked, before the pause begins. Read-only, non-blocking. */
  onSessionSleep: (context: SessionSleepHookContext) => Promise<void>;
  /** Called when session.signal() is invoked, after the run id is resolved. Read-only, non-blocking. */
  onSessionSignal: (context: SessionSignalHookContext) => Promise<void>;
  /** Called when session.update() is invoked, after the run id is resolved. Read-only, non-blocking. */
  onSessionUpdate: (context: SessionUpdateHookContext) => Promise<void>;
  /** Called when session.query() is invoked, after the last run is resolved. Read-only, non-blocking. */
  onSessionQuery: (context: SessionQueryHookContext) => Promise<void>;
}
