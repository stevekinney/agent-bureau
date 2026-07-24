import type { ToolboxEvents, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationEvents } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { CompletableEventTarget, EventMap, ForwardedEvent } from 'lifecycle';

import type { CostBudgetExceededEvent, CostBudgetThresholdEvent } from './cost-budget-monitor';
import { estimateCacheHitRate } from './cost-estimation';
import type { GenerateResponse, RunResult, StepResult, TokenUsage } from './types';

// ---------------------------------------------------------------------------
// Core operative events
// ---------------------------------------------------------------------------

export class RunStartedEvent extends Event {
  static readonly type = 'run.started' as const;
  readonly conversation: Conversation;
  constructor(conversation: Conversation) {
    super(RunStartedEvent.type);
    this.conversation = conversation;
  }
}

export class StepStartedEvent extends Event {
  static readonly type = 'step.started' as const;
  readonly conversation: Conversation;
  readonly step: number;
  constructor(conversation: Conversation, step: number) {
    super(StepStartedEvent.type);
    this.conversation = conversation;
    this.step = step;
  }
}

export class StepGeneratedEvent extends Event {
  static readonly type = 'step.generated' as const;
  readonly step: number;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: TokenUsage;
  constructor(data: {
    step: number;
    content: string;
    toolCalls: readonly ToolCall[];
    usage?: TokenUsage;
  }) {
    super(StepGeneratedEvent.type);
    this.step = data.step;
    this.content = data.content;
    this.toolCalls = data.toolCalls;
    this.usage = data.usage;
  }
}

export class ToolsExecutingEvent extends Event {
  static readonly type = 'tools.executing' as const;
  readonly step: number;
  readonly toolCalls: readonly ToolCall[];
  constructor(step: number, toolCalls: readonly ToolCall[]) {
    super(ToolsExecutingEvent.type);
    this.step = step;
    this.toolCalls = toolCalls;
  }
}

export class ToolsExecutedEvent extends Event {
  static readonly type = 'tools.executed' as const;
  readonly step: number;
  readonly toolCalls: readonly ToolCall[];
  readonly results: readonly ToolExecutionResult[];
  constructor(
    step: number,
    toolCalls: readonly ToolCall[],
    results: readonly ToolExecutionResult[],
  ) {
    super(ToolsExecutedEvent.type);
    this.step = step;
    this.toolCalls = toolCalls;
    this.results = results;
  }
}

export class StepCompletedEvent extends Event {
  static readonly type = 'step.completed' as const;
  readonly step: number;
  readonly conversation: Conversation;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly results: readonly ToolExecutionResult[];
  readonly usage?: TokenUsage;
  readonly metadata?: Record<string, unknown>;
  readonly final: boolean;
  constructor(data: StepResult) {
    super(StepCompletedEvent.type);
    this.step = data.step;
    this.conversation = data.conversation;
    this.content = data.content;
    this.toolCalls = data.toolCalls;
    this.results = data.results;
    this.usage = data.usage;
    this.metadata = data.metadata;
    this.final = data.final;
  }
}

export class RunCompletedEvent extends Event {
  static readonly type = 'run.completed' as const;
  readonly conversation: Conversation;
  readonly steps: readonly StepResult[];
  readonly content: string;
  readonly usage: TokenUsage;
  readonly finishReason: RunResult['finishReason'];
  readonly error?: unknown;
  readonly schemaValidation?: RunResult['schemaValidation'];
  /** See {@link RunResult.costEstimate}. */
  readonly costEstimate?: RunResult['costEstimate'];
  /** See {@link RunResult.structuredOutput}. */
  readonly structuredOutput?: unknown;
  constructor(data: RunResult) {
    super(RunCompletedEvent.type);
    this.conversation = data.conversation;
    this.steps = data.steps;
    this.content = data.content;
    this.usage = data.usage;
    this.finishReason = data.finishReason;
    this.error = data.error;
    this.schemaValidation = data.schemaValidation;
    this.costEstimate = data.costEstimate;
    this.structuredOutput = data.structuredOutput;
  }
}

export class RunErrorEvent extends Event {
  static readonly type = 'run.error' as const;
  readonly step: number;
  readonly error: unknown;
  constructor(step: number, error: unknown) {
    super(RunErrorEvent.type);
    this.step = step;
    this.error = error;
  }
}

export class RunAbortedEvent extends Event {
  static readonly type = 'run.aborted' as const;
  readonly step: number;
  readonly reason?: string;
  // The conversation as it stood when the run aborted. On the durable path the
  // workflow mutates per-step checkpoint snapshots, never the launch-time input
  // instance, so listeners MUST persist this conversation (the reconstructed /
  // checkpoint transcript) rather than the seed they captured at launch.
  readonly conversation: Conversation;
  /**
   * Accumulated usage at the point of abort — the same `runState.totalUsage`
   * `makeAbortResult` puts on the returned `RunResult`. Present so a listener
   * that only sees this event (rather than awaiting `run.result()`) can still
   * build an accurate terminal report (AB-96) without a race against the
   * result promise's microtask resolution.
   */
  readonly usage?: TokenUsage;
  /** See {@link RunResult.costEstimate}. Computed from `usage` when available. */
  readonly costEstimate?: RunResult['costEstimate'];
  constructor(
    step: number,
    conversation: Conversation,
    reason?: string,
    usage?: TokenUsage,
    costEstimate?: RunResult['costEstimate'],
  ) {
    super(RunAbortedEvent.type);
    this.step = step;
    this.conversation = conversation;
    this.reason = reason;
    this.usage = usage;
    this.costEstimate = costEstimate;
  }
}

/**
 * Fired when a `mode: 'tripwire'` guardrail halts a run. Dispatched alongside
 * (immediately before) `RunCompletedEvent` — that event carries the generic
 * `finishReason: 'tripwire'` + the reconstructed `GuardrailTripwireError` on
 * `.error`, while this event surfaces the guardrail identity as first-class
 * fields for listeners that only care about tripwires.
 */
export class RunTripwireEvent extends Event {
  static readonly type = 'run.tripwire' as const;
  readonly step: number;
  readonly guardrailName: string;
  readonly category: string;
  readonly phase: 'input' | 'output';
  readonly confidence: number;
  readonly detail?: string;
  constructor(
    step: number,
    data: {
      guardrailName: string;
      category: string;
      phase: 'input' | 'output';
      confidence: number;
      detail?: string;
    },
  ) {
    super(RunTripwireEvent.type);
    this.step = step;
    this.guardrailName = data.guardrailName;
    this.category = data.category;
    this.phase = data.phase;
    this.confidence = data.confidence;
    this.detail = data.detail;
  }
}

export class StepAbortedEvent extends Event {
  static readonly type = 'step.aborted' as const;
  readonly step: number;
  readonly reason?: string;
  constructor(step: number, reason?: string) {
    super(StepAbortedEvent.type);
    this.step = step;
    this.reason = reason;
  }
}

export class GenerateStartedEvent extends Event {
  static readonly type = 'generate.started' as const;
  readonly step: number;
  constructor(step: number) {
    super(GenerateStartedEvent.type);
    this.step = step;
  }
}

export class GenerateCompletedEvent extends Event {
  static readonly type = 'generate.completed' as const;
  readonly step: number;
  readonly response: GenerateResponse;
  readonly durationMilliseconds: number;
  constructor(step: number, response: GenerateResponse, durationMilliseconds: number) {
    super(GenerateCompletedEvent.type);
    this.step = step;
    this.response = response;
    this.durationMilliseconds = durationMilliseconds;
  }
}

export class GenerateErrorEvent extends Event {
  static readonly type = 'generate.error' as const;
  readonly step: number;
  readonly error: unknown;
  readonly durationMilliseconds: number;
  constructor(step: number, error: unknown, durationMilliseconds: number) {
    super(GenerateErrorEvent.type);
    this.step = step;
    this.error = error;
    this.durationMilliseconds = durationMilliseconds;
  }
}

export class GenerateRetryEvent extends Event {
  static readonly type = 'generate.retry' as const;
  readonly step: number;
  readonly attempt: number;
  readonly error: unknown;
  /** Whether the retry context was mutated by a RetryMutator. */
  readonly mutated: boolean;
  /** Human-readable description of the mutation, if any. */
  readonly mutationDescription?: string;
  constructor(
    step: number,
    attempt: number,
    error: unknown,
    mutated = false,
    mutationDescription?: string,
  ) {
    super(GenerateRetryEvent.type);
    this.step = step;
    this.attempt = attempt;
    this.error = error;
    this.mutated = mutated;
    this.mutationDescription = mutationDescription;
  }
}

export class ResponseValidatedEvent extends Event {
  static readonly type = 'response.validated' as const;
  readonly step: number;
  readonly original: GenerateResponse;
  readonly validated: GenerateResponse;
  constructor(step: number, original: GenerateResponse, validated: GenerateResponse) {
    super(ResponseValidatedEvent.type);
    this.step = step;
    this.original = original;
    this.validated = validated;
  }
}

export class ToolResultValidatedEvent extends Event {
  static readonly type = 'tool-result.validated' as const;
  readonly step: number;
  readonly original: ToolExecutionResult;
  readonly validated: ToolExecutionResult;
  constructor(step: number, original: ToolExecutionResult, validated: ToolExecutionResult) {
    super(ToolResultValidatedEvent.type);
    this.step = step;
    this.original = original;
    this.validated = validated;
  }
}

export class ContextCompactedEvent extends Event {
  static readonly type = 'context.compacted' as const;
  readonly step: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  constructor(step: number, tokensBefore: number, tokensAfter: number) {
    super(ContextCompactedEvent.type);
    this.step = step;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
  }
}

export class ResponseSchemaFailedEvent extends Event {
  static readonly type = 'response.schema-failed' as const;
  readonly step: number;
  readonly content: string;
  readonly error: unknown;
  readonly retriesRemaining: number;
  constructor(step: number, content: string, error: unknown, retriesRemaining: number) {
    super(ResponseSchemaFailedEvent.type);
    this.step = step;
    this.content = content;
    this.error = error;
    this.retriesRemaining = retriesRemaining;
  }
}

export class ElicitationRequestedEvent extends Event {
  static readonly type = 'elicitation.requested' as const;
  readonly step: number;
  readonly message: string;
  constructor(step: number, message: string) {
    super(ElicitationRequestedEvent.type);
    this.step = step;
    this.message = message;
  }
}

export class ElicitationResolvedEvent extends Event {
  static readonly type = 'elicitation.resolved' as const;
  readonly step: number;
  readonly accepted: boolean;
  constructor(step: number, accepted: boolean) {
    super(ElicitationResolvedEvent.type);
    this.step = step;
    this.accepted = accepted;
  }
}

export class BackpressureAppliedEvent extends Event {
  static readonly type = 'backpressure.applied' as const;
  readonly step: number;
  readonly delay: number;
  constructor(step: number, delay: number) {
    super(BackpressureAppliedEvent.type);
    this.step = step;
    this.delay = delay;
  }
}

export class BackpressureReleasedEvent extends Event {
  static readonly type = 'backpressure.released' as const;
  readonly step: number;
  constructor(step: number) {
    super(BackpressureReleasedEvent.type);
    this.step = step;
  }
}

export class UsageAccumulatedEvent extends Event {
  static readonly type = 'usage.accumulated' as const;
  readonly step: number;
  readonly stepUsage?: TokenUsage;
  readonly totalUsage: TokenUsage;
  /**
   * Prompt-cache hit rate for this step, from {@link estimateCacheHitRate}
   * applied to `stepUsage`. `undefined` when this step's response carried no
   * cache signal (provider didn't report `cacheReadTokens`/`cacheCreationTokens`,
   * or there was no usage at all).
   */
  readonly stepCacheHitRate?: number;
  /** Prompt-cache hit rate across the run so far, from `totalUsage`. */
  readonly totalCacheHitRate?: number;
  constructor(step: number, totalUsage: TokenUsage, stepUsage?: TokenUsage) {
    super(UsageAccumulatedEvent.type);
    this.step = step;
    this.stepUsage = stepUsage;
    this.totalUsage = totalUsage;
    const stepCacheHitRate = stepUsage ? estimateCacheHitRate(stepUsage) : undefined;
    const totalCacheHitRate = estimateCacheHitRate(totalUsage);
    if (stepCacheHitRate !== undefined) this.stepCacheHitRate = stepCacheHitRate;
    if (totalCacheHitRate !== undefined) this.totalCacheHitRate = totalCacheHitRate;
  }
}

export class BudgetThresholdEvent extends Event {
  static readonly type = 'budget.threshold' as const;
  readonly threshold: number;
  readonly currentCost: number;
  readonly budget: number;
  readonly model: string;
  constructor(data: CostBudgetThresholdEvent) {
    super(BudgetThresholdEvent.type);
    this.threshold = data.threshold;
    this.currentCost = data.currentCost;
    this.budget = data.budget;
    this.model = data.model;
  }
}

export class BudgetExceededEvent extends Event {
  static readonly type = 'budget.exceeded' as const;
  readonly currentCost: number;
  readonly budget: number;
  readonly model: string;
  constructor(data: CostBudgetExceededEvent) {
    super(BudgetExceededEvent.type);
    this.currentCost = data.currentCost;
    this.budget = data.budget;
    this.model = data.model;
  }
}

export class SessionSavedEvent extends Event {
  static readonly type = 'session.saved' as const;
  readonly sessionId: string;
  readonly agentName: string;
  constructor(sessionId: string, agentName: string) {
    super(SessionSavedEvent.type);
    this.sessionId = sessionId;
    this.agentName = agentName;
  }
}

export class SessionLoadedEvent extends Event {
  static readonly type = 'session.loaded' as const;
  readonly sessionId: string;
  readonly agentName: string;
  constructor(sessionId: string, agentName: string) {
    super(SessionLoadedEvent.type);
    this.sessionId = sessionId;
    this.agentName = agentName;
  }
}

export class SessionCreatedEvent extends Event {
  static readonly type = 'session.created' as const;
  readonly sessionId: string;
  readonly agentName: string;
  constructor(sessionId: string, agentName: string) {
    super(SessionCreatedEvent.type);
    this.sessionId = sessionId;
    this.agentName = agentName;
  }
}

export class SessionDeletedEvent extends Event {
  static readonly type = 'session.deleted' as const;
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(SessionDeletedEvent.type);
    this.sessionId = sessionId;
  }
}

export class ContextBudgetWarningEvent extends Event {
  static readonly type = 'context.budget-warning' as const;
  readonly step: number;
  readonly used: number;
  readonly remaining: number;
  readonly maxTokens: number;
  constructor(step: number, used: number, remaining: number, maxTokens: number) {
    super(ContextBudgetWarningEvent.type);
    this.step = step;
    this.used = used;
    this.remaining = remaining;
    this.maxTokens = maxTokens;
  }
}

// ---------------------------------------------------------------------------
// Curated tool.* events (C3 — bubbled from armorer's toolbox emitter,
// re-wrapped and stamped with {agentName, runId, step}).
//
// These are the CURATED set exposed on the run stream. The raw firehose
// (stream/log/chunk, ~20 events) stays available by subscribing to the
// toolbox directly. Enrichment happens at the operative boundary because
// armorer is correctly agent-blind — the metadata is what makes bubbled
// events usable in multi-agent topologies.
// ---------------------------------------------------------------------------

/** Stamp carried by every curated tool.* event on the run stream. */
export interface ToolEventStamp {
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
}

export class ToolStartedBubbleEvent extends Event {
  static readonly type = 'tool.started' as const;
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly params: unknown;
  readonly startedAt: number;
  constructor(
    stamp: ToolEventStamp,
    detail: { toolName: string; toolCallId: string; params: unknown; startedAt: number },
  ) {
    super(ToolStartedBubbleEvent.type);
    this.agentName = stamp.agentName;
    this.runId = stamp.runId;
    this.step = stamp.step;
    this.toolName = detail.toolName;
    this.toolCallId = detail.toolCallId;
    this.params = detail.params;
    this.startedAt = detail.startedAt;
  }
}

export class ToolProgressBubbleEvent extends Event {
  static readonly type = 'tool.progress' as const;
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly percent?: number;
  readonly message?: string;
  constructor(
    stamp: ToolEventStamp,
    detail: { toolName: string; toolCallId: string; percent?: number; message?: string },
  ) {
    super(ToolProgressBubbleEvent.type);
    this.agentName = stamp.agentName;
    this.runId = stamp.runId;
    this.step = stamp.step;
    this.toolName = detail.toolName;
    this.toolCallId = detail.toolCallId;
    this.percent = detail.percent;
    this.message = detail.message;
  }
}

export class ToolSettledBubbleEvent extends Event {
  static readonly type = 'tool.settled' as const;
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
  readonly durationMs?: number;
  readonly result?: unknown;
  readonly error?: unknown;
  constructor(
    stamp: ToolEventStamp,
    detail: {
      toolName: string;
      toolCallId: string;
      status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
      durationMs?: number;
      result?: unknown;
      error?: unknown;
    },
  ) {
    super(ToolSettledBubbleEvent.type);
    this.agentName = stamp.agentName;
    this.runId = stamp.runId;
    this.step = stamp.step;
    this.toolName = detail.toolName;
    this.toolCallId = detail.toolCallId;
    this.status = detail.status;
    this.durationMs = detail.durationMs;
    this.result = detail.result;
    this.error = detail.error;
  }
}

export class ToolErrorBubbleEvent extends Event {
  static readonly type = 'tool.error' as const;
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly error: unknown;
  constructor(
    stamp: ToolEventStamp,
    detail: { toolName: string; toolCallId: string; error: unknown },
  ) {
    super(ToolErrorBubbleEvent.type);
    this.agentName = stamp.agentName;
    this.runId = stamp.runId;
    this.step = stamp.step;
    this.toolName = detail.toolName;
    this.toolCallId = detail.toolCallId;
    this.error = detail.error;
  }
}

export class ToolPolicyDeniedBubbleEvent extends Event {
  static readonly type = 'tool.policy-denied' as const;
  readonly agentName: string;
  readonly runId: string;
  readonly step: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly reason?: string;
  constructor(
    stamp: ToolEventStamp,
    detail: { toolName: string; toolCallId: string; reason?: string },
  ) {
    super(ToolPolicyDeniedBubbleEvent.type);
    this.agentName = stamp.agentName;
    this.runId = stamp.runId;
    this.step = stamp.step;
    this.toolName = detail.toolName;
    this.toolCallId = detail.toolCallId;
    this.reason = detail.reason;
  }
}

// ---------------------------------------------------------------------------
// Session verb events (C3 completeness rule — every new state transition
// emits an event). Covers: recover / cancel / fork / sleep / signal / update / query.
// Multi-agent transitions (child-workflow-started, handoff-occurred,
// human-wait-parked) are implemented below in the Phase F section.
// ---------------------------------------------------------------------------

export class SessionRecoverEvent extends Event {
  static readonly type = 'session.recover' as const;
  readonly sessionId: string;
  readonly runId: string | null;
  constructor(sessionId: string, runId: string | null) {
    super(SessionRecoverEvent.type);
    this.sessionId = sessionId;
    this.runId = runId;
  }
}

export class SessionCancelEvent extends Event {
  static readonly type = 'session.cancel' as const;
  readonly sessionId: string;
  readonly runId: string | null;
  constructor(sessionId: string, runId: string | null) {
    super(SessionCancelEvent.type);
    this.sessionId = sessionId;
    this.runId = runId;
  }
}

export class SessionForkEvent extends Event {
  static readonly type = 'session.fork' as const;
  readonly sourceSessionId: string;
  readonly forkedSessionId: string;
  readonly throughRun?: number;
  constructor(sourceSessionId: string, forkedSessionId: string, throughRun?: number) {
    super(SessionForkEvent.type);
    this.sourceSessionId = sourceSessionId;
    this.forkedSessionId = forkedSessionId;
    this.throughRun = throughRun;
  }
}

export class SessionSleepEvent extends Event {
  static readonly type = 'session.sleep' as const;
  readonly sessionId: string;
  readonly durationMs: number;
  constructor(sessionId: string, durationMs: number) {
    super(SessionSleepEvent.type);
    this.sessionId = sessionId;
    this.durationMs = durationMs;
  }
}

export class SessionSignalEvent extends Event {
  static readonly type = 'session.signal' as const;
  readonly sessionId: string;
  readonly runId: string;
  readonly signalName: string;
  readonly payload: unknown;
  constructor(sessionId: string, runId: string, signalName: string, payload: unknown) {
    super(SessionSignalEvent.type);
    this.sessionId = sessionId;
    this.runId = runId;
    this.signalName = signalName;
    this.payload = payload;
  }
}

export class SessionUpdateEvent extends Event {
  static readonly type = 'session.update' as const;
  readonly sessionId: string;
  readonly runId: string;
  readonly updateName: string;
  readonly payload: unknown;
  constructor(sessionId: string, runId: string, updateName: string, payload: unknown) {
    super(SessionUpdateEvent.type);
    this.sessionId = sessionId;
    this.runId = runId;
    this.updateName = updateName;
    this.payload = payload;
  }
}

export class SessionQueryEvent extends Event {
  static readonly type = 'session.query' as const;
  readonly sessionId: string;
  readonly queryName: string;
  readonly input: unknown;
  constructor(sessionId: string, queryName: string, input: unknown) {
    super(SessionQueryEvent.type);
    this.sessionId = sessionId;
    this.queryName = queryName;
    this.input = input;
  }
}

/**
 * Emitted when a `session.monitor()` loop ticks (starts a new poll run).
 * Carries the tick number (0-based) and whether the predicate was satisfied.
 * The `met` field is `null` on the tick-started emission (before the run
 * completes) and `true` / `false` after the predicate is evaluated.
 */
export class SessionMonitorTickEvent extends Event {
  static readonly type = 'session.monitor.tick' as const;
  readonly sessionId: string;
  readonly tick: number;
  /** Whether the `until` predicate was satisfied. `null` before the run finishes. */
  readonly met: boolean | null;
  constructor(sessionId: string, tick: number, met: boolean | null) {
    super(SessionMonitorTickEvent.type);
    this.sessionId = sessionId;
    this.tick = tick;
    this.met = met;
  }
}

/**
 * Emitted when a `session.monitor()` loop completes — either because the
 * predicate was satisfied or the `maxDuration` deadline was reached.
 */
export class SessionMonitorDoneEvent extends Event {
  static readonly type = 'session.monitor.done' as const;
  readonly sessionId: string;
  /** Whether the loop exited because the `until` predicate was satisfied. */
  readonly met: boolean;
  /** Total number of ticks executed (including the final one). */
  readonly ticks: number;
  constructor(sessionId: string, met: boolean, ticks: number) {
    super(SessionMonitorDoneEvent.type);
    this.sessionId = sessionId;
    this.met = met;
    this.ticks = ticks;
  }
}

// ---------------------------------------------------------------------------
// Phase F — Durable multi-agent transition events (C3 / invariant #2 rule).
// Every multi-agent state transition emits an event and exposes a hook.
// ---------------------------------------------------------------------------

/**
 * Emitted when a subagent tool starts executing a child run.
 *
 * On the in-memory path the child run is a plain async call. On the durable
 * path (when `.persistence()` is set on the bureau) it is a child workflow
 * launched via the Weft engine. Either way this event fires at the point the
 * delegation begins, carrying enough context to reconstruct the multi-agent tree
 * (parent agent + run, child agent, request).
 */
export class ChildWorkflowStartedEvent extends Event {
  static readonly type = 'multiagent.child-workflow.started' as const;
  /** The agent name delegating to the subagent. */
  readonly parentAgentName: string;
  /** The parent run id (derived as `${sessionId}:${sequence}`). */
  readonly parentRunId: string;
  /** The subagent's name. */
  readonly childAgentName: string;
  /** The prompt sent to the subagent. */
  readonly input: string;
  /** True when the child is a durable Weft child workflow; false for in-process. */
  readonly durable: boolean;

  constructor(data: {
    parentAgentName: string;
    parentRunId: string;
    childAgentName: string;
    input: string;
    durable: boolean;
  }) {
    super(ChildWorkflowStartedEvent.type);
    this.parentAgentName = data.parentAgentName;
    this.parentRunId = data.parentRunId;
    this.childAgentName = data.childAgentName;
    this.input = data.input;
    this.durable = data.durable;
  }
}

/**
 * Emitted when a handoff tool transfers control to another agent.
 *
 * On the in-process path the handoff embeds a `HANDOFF_MARKER` in the result
 * and the caller re-dispatches. On the durable session-continuation path
 * (F2) the handoff creates a new run in the same session bound to the target
 * agent — the session is worked by a sequence of agents over time.
 */
export class HandoffOccurredEvent extends Event {
  static readonly type = 'multiagent.handoff.occurred' as const;
  /** The agent that is handing off. */
  readonly sourceAgentName: string;
  /** The agent receiving the handoff. */
  readonly targetAgentName: string;
  /** The session id (if the handoff is session-scoped). */
  readonly sessionId?: string;

  constructor(data: { sourceAgentName: string; targetAgentName: string; sessionId?: string }) {
    super(HandoffOccurredEvent.type);
    this.sourceAgentName = data.sourceAgentName;
    this.targetAgentName = data.targetAgentName;
    this.sessionId = data.sessionId;
  }
}

/**
 * Emitted when a durable run parks on `ctx.waitForSignal` waiting for a
 * human-in-the-loop approval (or any external event delivered via
 * `session.signal()`).
 *
 * The parked run costs nothing (no active compute, no timer threads) and
 * survives restarts. It is resumed by delivering the named signal via
 * `session.signal(signalName, payload)`.
 */
export class HumanWaitParkedEvent extends Event {
  static readonly type = 'multiagent.human-wait.parked' as const;
  /** The signal name the run is parked on (e.g. `'human-response'`). */
  readonly signalName: string;
  /** The run id of the parked workflow. */
  readonly runId: string;
  /**
   * The prompt to surface to the human reviewer, if one was supplied to
   * `requestHumanInput`. Lets event-stream/UI consumers show what approval or
   * input is being requested without subscribing to the tool result.
   */
  readonly prompt: string | undefined;

  constructor(signalName: string, runId: string, prompt?: string) {
    super(HumanWaitParkedEvent.type);
    this.signalName = signalName;
    this.runId = runId;
    this.prompt = prompt;
  }
}

// ---------------------------------------------------------------------------
// Scheduling events (D6 — Tier-1 scheduling completeness rule).
// Every state transition emits an event (C3 / invariant #2 rule).
// ---------------------------------------------------------------------------

/**
 * Emitted when a durable agent schedule is registered via `bureau.schedule()`
 * or the `scheduleSelf` tool.
 */
export class AgentScheduledEvent extends Event {
  static readonly type = 'schedule.created' as const;
  readonly agentName: string;
  readonly scheduleId: string;
  readonly spec: { cron?: string; every?: string | number };
  readonly sessionId?: string;
  constructor(data: {
    agentName: string;
    scheduleId: string;
    spec: { cron?: string; every?: string | number };
    sessionId?: string;
  }) {
    super(AgentScheduledEvent.type);
    this.agentName = data.agentName;
    this.scheduleId = data.scheduleId;
    this.spec = data.spec;
    this.sessionId = data.sessionId;
  }
}

/**
 * Emitted when a running agent calls `scheduleWakeup({in, note})` to park the
 * current durable run and resume after a delay.
 */
export class WakeupScheduledEvent extends Event {
  static readonly type = 'schedule.wakeup' as const;
  readonly duration: number | string;
  readonly note?: string;
  constructor(duration: number | string, note?: string) {
    super(WakeupScheduledEvent.type);
    this.duration = duration;
    this.note = note;
  }
}

// ---------------------------------------------------------------------------
// Workflow versioning (AB-10). Emitted, NOT through the per-run
// `CombinedOperativeEventMap` emitter (a recovered run's dependencies —
// including its emitter — are rebuilt AFTER this check runs, and a headless
// durable run has no emitter at all) but via the plain callback injection
// `CreateRunEngineOptions.onWorkflowVersionMismatch`, matching
// `onCheckpointSizeWarning`'s pattern.
// ---------------------------------------------------------------------------

/**
 * Emitted when a recovered run's checkpointed `workflowVersion` (stamped at
 * creation, see `createRunWorkflow`'s `version` option) differs from the
 * currently-registered `CreateRunEngineOptions.runWorkflowVersion`. This is a
 * pin-and-warn observation, not a control: the recovery itself is never
 * blocked or altered by this event — see `runWorkflowVersion`'s JSDoc for why.
 */
export class WorkflowVersionMismatchEvent extends Event {
  static readonly type = 'workflow.version-mismatch' as const;
  readonly runId: string;
  readonly storedVersion: string;
  readonly registeredVersion: string;
  constructor(runId: string, storedVersion: string, registeredVersion: string) {
    super(WorkflowVersionMismatchEvent.type);
    this.runId = runId;
    this.storedVersion = storedVersion;
    this.registeredVersion = registeredVersion;
  }
}

// ---------------------------------------------------------------------------
// Event map: maps event type string to the Event subclass instance
// ---------------------------------------------------------------------------

export interface OperativeEventMap extends EventMap {
  [RunStartedEvent.type]: RunStartedEvent;
  [StepStartedEvent.type]: StepStartedEvent;
  [StepGeneratedEvent.type]: StepGeneratedEvent;
  [ToolsExecutingEvent.type]: ToolsExecutingEvent;
  [ToolsExecutedEvent.type]: ToolsExecutedEvent;
  [StepCompletedEvent.type]: StepCompletedEvent;
  [RunCompletedEvent.type]: RunCompletedEvent;
  [RunErrorEvent.type]: RunErrorEvent;
  [RunAbortedEvent.type]: RunAbortedEvent;
  [RunTripwireEvent.type]: RunTripwireEvent;
  [StepAbortedEvent.type]: StepAbortedEvent;
  [GenerateStartedEvent.type]: GenerateStartedEvent;
  [GenerateCompletedEvent.type]: GenerateCompletedEvent;
  [GenerateErrorEvent.type]: GenerateErrorEvent;
  [GenerateRetryEvent.type]: GenerateRetryEvent;
  [ResponseValidatedEvent.type]: ResponseValidatedEvent;
  [ToolResultValidatedEvent.type]: ToolResultValidatedEvent;
  [ContextCompactedEvent.type]: ContextCompactedEvent;
  [ResponseSchemaFailedEvent.type]: ResponseSchemaFailedEvent;
  [ElicitationRequestedEvent.type]: ElicitationRequestedEvent;
  [ElicitationResolvedEvent.type]: ElicitationResolvedEvent;
  [BackpressureAppliedEvent.type]: BackpressureAppliedEvent;
  [BackpressureReleasedEvent.type]: BackpressureReleasedEvent;
  [UsageAccumulatedEvent.type]: UsageAccumulatedEvent;
  [BudgetThresholdEvent.type]: BudgetThresholdEvent;
  [BudgetExceededEvent.type]: BudgetExceededEvent;
  [SessionSavedEvent.type]: SessionSavedEvent;
  [SessionLoadedEvent.type]: SessionLoadedEvent;
  [SessionCreatedEvent.type]: SessionCreatedEvent;
  [SessionDeletedEvent.type]: SessionDeletedEvent;
  [ContextBudgetWarningEvent.type]: ContextBudgetWarningEvent;
  // Curated tool.* bubbled events (C3)
  [ToolStartedBubbleEvent.type]: ToolStartedBubbleEvent;
  [ToolProgressBubbleEvent.type]: ToolProgressBubbleEvent;
  [ToolSettledBubbleEvent.type]: ToolSettledBubbleEvent;
  [ToolErrorBubbleEvent.type]: ToolErrorBubbleEvent;
  [ToolPolicyDeniedBubbleEvent.type]: ToolPolicyDeniedBubbleEvent;
  // Session verb events (C3 completeness rule)
  [SessionRecoverEvent.type]: SessionRecoverEvent;
  [SessionCancelEvent.type]: SessionCancelEvent;
  [SessionForkEvent.type]: SessionForkEvent;
  [SessionSleepEvent.type]: SessionSleepEvent;
  [SessionSignalEvent.type]: SessionSignalEvent;
  [SessionUpdateEvent.type]: SessionUpdateEvent;
  [SessionQueryEvent.type]: SessionQueryEvent;
  // Scheduling events (D6 completeness rule)
  [AgentScheduledEvent.type]: AgentScheduledEvent;
  [WakeupScheduledEvent.type]: WakeupScheduledEvent;
  // session.monitor loop events (D7)
  [SessionMonitorTickEvent.type]: SessionMonitorTickEvent;
  [SessionMonitorDoneEvent.type]: SessionMonitorDoneEvent;
  // Phase F — durable multi-agent transition events (C3 completeness rule)
  [ChildWorkflowStartedEvent.type]: ChildWorkflowStartedEvent;
  [HandoffOccurredEvent.type]: HandoffOccurredEvent;
  [HumanWaitParkedEvent.type]: HumanWaitParkedEvent;
}

export type OperativeEventType = keyof OperativeEventMap;

type PrefixedToolboxEvents = {
  [K in keyof ToolboxEvents as `toolbox.${K & string}`]: ForwardedEvent;
};

type PrefixedConversationEvents = {
  [K in keyof ConversationEvents as `conversation.${K & string}`]: ForwardedEvent;
};

export interface ForwardedEvents extends PrefixedToolboxEvents, PrefixedConversationEvents {}

export interface CombinedOperativeEventMap extends OperativeEventMap, ForwardedEvents {}

export type CombinedOperativeEventType = keyof CombinedOperativeEventMap;

/**
 * The complete event surface accepted by durable routing. This deliberately
 * omits CompletableEventTarget's private state while retaining every method
 * the durable adapter calls; a dispatch-only object is not a valid emitter.
 */
export type OperativeEventEmitter = Pick<
  CompletableEventTarget<CombinedOperativeEventMap>,
  | 'addEventListener'
  | 'removeEventListener'
  | 'dispatch'
  | 'dispatchEvent'
  | 'on'
  | 'once'
  | 'subscribe'
  | 'events'
  | 'toObservable'
  | 'complete'
>;

// Backward-compatible aliases
export type OperativeEvents = {
  [K in keyof OperativeEventMap]: OperativeEventMap[K];
};
export type CombinedOperativeEvents = {
  [K in keyof CombinedOperativeEventMap]: CombinedOperativeEventMap[K];
};
