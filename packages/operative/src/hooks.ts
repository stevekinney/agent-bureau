import type { HookMap } from '@lostgradient/lifecycle';
import type { ToolCall } from '@lostgradient/tool-protocol';
import type { AnyToolbox, ToolExecutionResult } from 'armorer';

import type { TokenBudget } from './context/index';
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
// COR-1266 — the curated `tool.*`, session-verb, context-assembly and
// multi-agent hook context types that used to live here are gone, along with
// the 21 `OperativeHookMap` keys that referenced them. None was ever
// dispatched: no `run`/`runFirst`/`runLast`/`runHandler`/`runHookSilently`
// call anywhere named one, so the map asserted a capability the runtime did
// not provide.
//
// Do not restore them from a name sighting. `onToolStarted`, `onToolSettled`
// and `onToolProgress` still appear in `durable/active-run-create.ts` and
// `durable/active-run-create-event-surface.ts` as local callback parameters
// and bubble-event handlers, and `ChildWorkflowStartedEvent`,
// `HandoffOccurredEvent` and `HumanWaitParkedEvent` are live event classes.
// Those are an unrelated event-plumbing vocabulary that happens to share the
// names; the collision was identified and resolved deliberately (COR-567's
// audit), not overlooked.
//
// Each removed name already had a typed, dispatched event carrying the same
// fact. Re-adding a hook for one would be the project's own non-goals —
// "Replacing typed events with hooks" and "Making every event a mutation
// hook" — so the answer to "where did my hook go" is: listen to the event.
// ---------------------------------------------------------------------------

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
  selectTools: (context: StepContext) => Promise<AnyToolbox>;
  validateResponse: (
    response: GenerateResponse,
    context: StepContext,
  ) => Promise<GenerateResponse | void>;
  validateToolResult: (
    result: ToolExecutionResult,
    context: ToolExecutionResultContext,
  ) => Promise<ToolExecutionResult | void>;
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
