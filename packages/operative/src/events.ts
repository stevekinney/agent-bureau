import type { ToolboxEvents, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationActionType } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { EventMap, ForwardedEvent, ObservableLike, Observer, Subscription } from 'lifecycle';

import type { CostBudgetExceededEvent, CostBudgetThresholdEvent } from './cost-budget-monitor';
import { estimateCacheHitRate } from './cost-estimation';
import type { SteeringCommandFailure, SteeringEffectiveState } from './durable/types';
import { type AgentRunError, type AgentRunErrorKind, toAgentRunError } from './errors';
import type { SemanticProgress } from './liveness';
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

export class RunCompletedEvent<O = unknown, H extends boolean = true> extends Event {
  static readonly type = 'run.completed' as const;
  readonly result: RunResult<O, H>;
  readonly conversation: Conversation;
  readonly steps: readonly StepResult[];
  readonly content: string;
  readonly usage: TokenUsage;
  readonly finishReason: RunResult['finishReason'];
  readonly error?: unknown;
  readonly schemaValidation?: RunResult['schemaValidation'];
  /** See {@link RunResult.costEstimate}. */
  readonly costEstimate?: RunResult['costEstimate'];
  /** See {@link RunResult.output}. */
  readonly output?: unknown;
  constructor(data: RunResult<O, H>) {
    super(RunCompletedEvent.type);
    this.result = data;
    this.conversation = data.conversation;
    this.steps = data.steps;
    this.content = data.content;
    this.usage = data.usage;
    this.finishReason = data.finishReason;
    this.error = data.error;
    this.schemaValidation = data.schemaValidation;
    this.costEstimate = data.costEstimate;
    this.output = 'output' in data ? data.output : undefined;
  }
}

export class RunErrorEvent extends Event {
  static readonly type = 'run.error' as const;
  readonly step: number;
  readonly error: AgentRunError;
  constructor(step: number, error: unknown, kind?: AgentRunErrorKind) {
    super(RunErrorEvent.type);
    this.step = step;
    this.error = toAgentRunError(error, { kind });
  }
}

export class RunAbortedEvent extends Event {
  static readonly type = 'run.aborted' as const;
  readonly step: number;
  readonly error: AgentRunError;
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
    error: AgentRunError,
    usage?: TokenUsage,
    costEstimate?: RunResult['costEstimate'],
    reason?: string,
  ) {
    super(RunAbortedEvent.type);
    this.step = step;
    this.conversation = conversation;
    this.error = error;
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

/**
 * One rejected `engine.resume(runId)` attempt encountered while `recover()`
 * walked a session's `running` refs looking for a durable run to re-attach
 * to. A run can end up here for reasons that range from benign (the run is
 * already terminal — the case `AB-28` reconciles by fixing the persisted
 * ref) to genuinely broken (the workflow's services could not be resolved,
 * the engine rejected the resume outright, etc.). This shape does not
 * distinguish those causes — Weft's `engine.resume()` throws a plain `Error`
 * for both, with no typed discriminant to key off of (tracked upstream:
 * weft task 8d22de1e-d4d9-43f5-bccb-56d25e104d7f) — it only guarantees the
 * `runId` and `error` are observable, so a consumer that cares about the
 * difference inspects `error` itself.
 */
export interface SessionRecoverFailure {
  readonly runId: string;
  readonly error: unknown;
}

export class SessionRecoverEvent extends Event {
  static readonly type = 'session.recover' as const;
  readonly sessionId: string;
  readonly runId: string | null;
  /**
   * Every `engine.resume(runId)` rejection encountered during this
   * `recover()` call, in the order they were tried (newest `running` ref
   * first). Empty only when NO resume attempt rejected — that covers both
   * "no durable re-attach was attempted" (in-process fast path or no
   * `running` refs, where `runId` is also `null`) and a clean successful
   * reattach on the first try. It is NOT empty on a mixed outcome, where a
   * newer `running` ref rejected before an older one succeeded — that event
   * carries the successful `runId` alongside the accumulated failures from
   * the refs tried before it, so neither signal is lost.
   */
  readonly failures: readonly SessionRecoverFailure[];
  constructor(
    sessionId: string,
    runId: string | null,
    failures: readonly SessionRecoverFailure[] = [],
  ) {
    super(SessionRecoverEvent.type);
    this.sessionId = sessionId;
    this.runId = runId;
    // Copy (and freeze) so a caller that mutates the array it passed in — or
    // that `recover()` keeps accumulating into across older running refs —
    // cannot retroactively change an already-dispatched event's payload.
    this.failures = Object.freeze([...failures]);
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

/** Emitted before a process-local `session.sleep()` timer starts. */
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
 * Emitted when a process-local `session.monitor()` loop ticks (starts a new poll run).
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
 * Emitted when a process-local `session.monitor()` loop completes—either
 * because the predicate was satisfied or the `maxDuration` deadline was reached.
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
  /**
   * The child's own run id (AB-50), distinct from `parentRunId` — the
   * correlation key `ChildWorkflowCompletedEvent`/`ChildWorkflowFailedEvent`/
   * `ChildWorkflowAbortedEvent` share with this event. Optional so a caller
   * constructing this event directly (as existing tests and any code
   * predating AB-50 do) is not forced to invent one; `dispatchChildRun`
   * always supplies it.
   */
  readonly childRunId: string | undefined;
  /** The prompt sent to the subagent. */
  readonly input: string;
  /** True when the child is a durable Weft child workflow; false for in-process. */
  readonly durable: boolean;

  constructor(data: {
    parentAgentName: string;
    parentRunId: string;
    childAgentName: string;
    childRunId?: string;
    input: string;
    durable: boolean;
  }) {
    super(ChildWorkflowStartedEvent.type);
    this.parentAgentName = data.parentAgentName;
    this.parentRunId = data.parentRunId;
    this.childAgentName = data.childAgentName;
    this.childRunId = data.childRunId;
    this.input = data.input;
    this.durable = data.durable;
  }
}

/**
 * Fields common to every `multiagent.child-workflow.*` terminal event
 * (completed/failed/aborted) — the parent-child correlation a caller needs
 * to attribute a terminal transition to the child it came from, matching
 * `ChildWorkflowStartedEvent`'s own identity fields.
 */
export interface ChildWorkflowCorrelation {
  readonly parentAgentName: string;
  readonly parentRunId: string;
  readonly childAgentName: string;
  readonly childRunId: string;
}

/**
 * Emitted when a child run dispatched via `dispatchChildRun` (and therefore
 * `createSubagentTool`) reaches a clean stop (`finishReason ===
 * 'stop-condition'`), whether or not its output passed schema validation —
 * `createSubagentTool` classifies that narrower case as a `SubagentRunError`
 * on its own return value, but the child's own lifecycle still completed.
 */
export class ChildWorkflowCompletedEvent extends Event implements ChildWorkflowCorrelation {
  static readonly type = 'multiagent.child-workflow.completed' as const;
  readonly parentAgentName: string;
  readonly parentRunId: string;
  readonly childAgentName: string;
  readonly childRunId: string;
  constructor(data: ChildWorkflowCorrelation) {
    super(ChildWorkflowCompletedEvent.type);
    this.parentAgentName = data.parentAgentName;
    this.parentRunId = data.parentRunId;
    this.childAgentName = data.childAgentName;
    this.childRunId = data.childRunId;
  }
}

/**
 * Emitted when a child run terminates with a non-aborted failure —
 * `finishReason` other than `'stop-condition'` or `'aborted'` (an execution
 * error, a tripwire, budget exceeded, elicitation denied, or maximum
 * steps), or an unexpected rejection from the child's own `result()`.
 */
export class ChildWorkflowFailedEvent extends Event implements ChildWorkflowCorrelation {
  static readonly type = 'multiagent.child-workflow.failed' as const;
  readonly parentAgentName: string;
  readonly parentRunId: string;
  readonly childAgentName: string;
  readonly childRunId: string;
  /** The child's terminal `finishReason`, or the rejection's message. */
  readonly reason: string;
  constructor(data: ChildWorkflowCorrelation & { reason: string }) {
    super(ChildWorkflowFailedEvent.type);
    this.parentAgentName = data.parentAgentName;
    this.parentRunId = data.parentRunId;
    this.childAgentName = data.childAgentName;
    this.childRunId = data.childRunId;
    this.reason = data.reason;
  }
}

/**
 * Emitted when a child run terminates because it (or its parent) was
 * aborted — `finishReason === 'aborted'`. Fires for both a child-targeted
 * `abort()` and a propagated parent abort; a caller distinguishes the two
 * by which signal it observed firing, not from this event.
 */
export class ChildWorkflowAbortedEvent extends Event implements ChildWorkflowCorrelation {
  static readonly type = 'multiagent.child-workflow.aborted' as const;
  readonly parentAgentName: string;
  readonly parentRunId: string;
  readonly childAgentName: string;
  readonly childRunId: string;
  /** The abort reason, when the aborting signal carried a string one. */
  readonly reason: string | undefined;
  constructor(data: ChildWorkflowCorrelation & { reason?: string }) {
    super(ChildWorkflowAbortedEvent.type);
    this.parentAgentName = data.parentAgentName;
    this.parentRunId = data.parentRunId;
    this.childAgentName = data.childAgentName;
    this.childRunId = data.childRunId;
    this.reason = data.reason;
  }
}

/**
 * Fields `ChildWorkflowReattachedEvent` carries — deliberately narrower
 * than {@link ChildWorkflowCorrelation}: AB-53's persisted topology
 * recovery (this event's only dispatch point, not yet wired — see below)
 * reattaches a child run by its persisted identity, not by the
 * `parentAgentName`/`childAgentName` labels a live dispatch call site
 * supplies. AB-222's own acceptance criteria fix this payload shape at
 * exactly `childRunId`/`parentRunId`.
 */
export interface ChildWorkflowReattachedPayload {
  readonly childRunId: string;
  readonly parentRunId: string;
}

/**
 * Emitted when AB-53's persisted parent-child topology recovery reattaches
 * a previously detached child's event stream to its parent — distinct from
 * `ChildWorkflowStartedEvent`, which fires only for a fresh dispatch.
 *
 * AB-222 defines this event's type, payload shape, and (once AB-53 exists)
 * intended dispatch point; it does not itself implement persisted topology
 * or recovery, so nothing in this package dispatches this event today. It
 * ships typed and exported, but never dispatched, until a later follow-up
 * wires the dispatch call site against AB-53's recovery hook — the same
 * pattern AB-87's matrix uses elsewhere for a not-yet-reachable transition.
 */
export class ChildWorkflowReattachedEvent extends Event implements ChildWorkflowReattachedPayload {
  static readonly type = 'multiagent.child-workflow.reattached' as const;
  readonly childRunId: string;
  readonly parentRunId: string;
  constructor(data: ChildWorkflowReattachedPayload) {
    super(ChildWorkflowReattachedEvent.type);
    this.childRunId = data.childRunId;
    this.parentRunId = data.parentRunId;
  }
}

/**
 * Fields `ChildWorkflowProgressEvent` carries: the same
 * `childRunId`/`parentRunId` correlation every `multiagent.child-workflow.*`
 * event carries, plus the child's own `SemanticProgress` (AB-88's decision
 * record, shipped by AB-214/obs-01 at `./liveness`).
 */
export interface ChildWorkflowProgressPayload {
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly progress: SemanticProgress;
}

/**
 * A child run's own semantic-progress pulse, surfaced to its parent.
 *
 * Explicitly non-cursor-advancing (AB-87's AC5 exhaustive list, extended to
 * this new family): an ephemeral delta describing the child's current
 * phase/position, never a durable state transition. A consumer that needs
 * the child's terminal outcome still waits for
 * `ChildWorkflowCompletedEvent`/`ChildWorkflowFailedEvent`/`ChildWorkflowAbortedEvent`;
 * this event never substitutes for one of those.
 */
export class ChildWorkflowProgressEvent extends Event implements ChildWorkflowProgressPayload {
  static readonly type = 'multiagent.child-workflow.progress' as const;
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly progress: SemanticProgress;
  constructor(data: ChildWorkflowProgressPayload) {
    super(ChildWorkflowProgressEvent.type);
    this.childRunId = data.childRunId;
    this.parentRunId = data.parentRunId;
    this.progress = data.progress;
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
 * Emitted when a durable agent schedule is genuinely newly registered — never
 * for an idempotent re-registration that reuses an existing schedule, nor for
 * a shared heartbeat's re-registration (AB-298). Dispatched by
 * `createAgentSchedule`/`createAgentScheduler` (`Bureau.createSchedule`,
 * `AgentScheduler.schedule`, and the `scheduleSelf` tool all route through
 * `createAgentSchedule`) and by `createDurableHeartbeat`, whenever a caller
 * supplies an `emitter`.
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
// Schedule definition lifecycle (AB-223, dispatching AB-87's decision record
// and the coordinator ruling that re-scoped AB-223 to five events).
//
// `schedule.paused`/`schedule.resumed`/`schedule.cancelled` are dispatched from
// each of the three sibling creation paths' own pause/resume/cancel: the
// bureau's `pauseSchedule`/`resumeSchedule`/`cancelSchedule` (which call the
// Weft engine directly), `AgentScheduleHandle`'s `pause`/`resume`/`cancel`
// (`durable/schedule-agent.ts`, an optional `emitter` on
// `CreateAgentScheduleOptions`/`createAgentScheduler`), and `DurableHeartbeat`'s
// `pause`/`resume`/`cancel` (`scheduler/create-durable-heartbeat.ts`, an
// optional `emitter` on `CreateDurableHeartbeatOptions`). Each site is a
// standalone module with no ambient emitter of its own, so the emitter is
// threaded in as an optional constructor/options field rather than assumed —
// a caller with no event surface (a headless script, a test) gets no dispatch
// and no error.
//
// `schedule.deleted` is reserved and UNREACHABLE, not built: Gateway's
// `DELETE /schedules/:id` routes through `Bureau.cancelSchedule` — cancel and
// delete are one call site — so only `ScheduleCancelledEvent` is ever
// dispatched. No distinct delete surface exists anywhere in Agent Bureau's
// public API today (coordinator ruling, AB-223, 2026-09-02).
// ---------------------------------------------------------------------------

/**
 * Emitted when a durable agent schedule is paused. Fires exactly once per
 * successful `pause()` call, from whichever of the three creation paths'
 * handles the caller is holding.
 */
export class SchedulePausedEvent extends Event {
  static readonly type = 'schedule.paused' as const;
  readonly scheduleId: string;
  constructor(scheduleId: string) {
    super(SchedulePausedEvent.type);
    this.scheduleId = scheduleId;
  }
}

/**
 * Emitted when a previously paused durable agent schedule is resumed. Fires
 * exactly once per successful `resume()` call.
 */
export class ScheduleResumedEvent extends Event {
  static readonly type = 'schedule.resumed' as const;
  readonly scheduleId: string;
  constructor(scheduleId: string) {
    super(ScheduleResumedEvent.type);
    this.scheduleId = scheduleId;
  }
}

/**
 * Emitted when a durable agent schedule is cancelled (terminal). Fires
 * exactly once per successful `cancel()` call that actually cancels the
 * underlying Weft schedule — `DurableHeartbeat.cancel()` unregistering one of
 * several services sharing a schedule, without cancelling the schedule
 * itself, does not fire this (the schedule is not cancelled; only this
 * caller's participation ends).
 */
export class ScheduleCancelledEvent extends Event {
  static readonly type = 'schedule.cancelled' as const;
  readonly scheduleId: string;
  constructor(scheduleId: string) {
    super(ScheduleCancelledEvent.type);
    this.scheduleId = scheduleId;
  }
}

/**
 * Emitted when a scheduled fire's AgentRun terminates in a failure outcome —
 * a thrown/unhandled workflow error, or a `RunResult` whose `finishReason`
 * `isRunFailureFinishReason` classifies as a failure (`error`, `tripwire`,
 * `maximum-steps`, `elicitation-denied`, `budget-exceeded`). Distinct from the
 * fired run's own `run.error`; correlates to it via `runId`. Dispatched from
 * `runtime-composition.ts`'s fire-terminal path (a Weft engine
 * `workflow:completed`/`workflow:failed` listener correlated against the
 * scheduleId recorded when the fire's deps were built), for both a live tick
 * and a recovered fire — exactly once either way, since both settle through
 * the same engine-level terminal event.
 */
export class ScheduleFailedEvent extends Event {
  static readonly type = 'schedule.failed' as const;
  readonly scheduleId: string;
  readonly runId: string;
  constructor(scheduleId: string, runId: string) {
    super(ScheduleFailedEvent.type);
    this.scheduleId = scheduleId;
    this.runId = runId;
  }
}

/**
 * Emitted when a scheduled fire's AgentRun terminates successfully. Distinct
 * from the fired run's own `run.completed`; correlates to it via `runId`. See
 * {@link ScheduleFailedEvent} for the dispatch path and live/recovered parity.
 */
export class ScheduleCompletedEvent extends Event {
  static readonly type = 'schedule.completed' as const;
  readonly scheduleId: string;
  readonly runId: string;
  constructor(scheduleId: string, runId: string) {
    super(ScheduleCompletedEvent.type);
    this.scheduleId = scheduleId;
    this.runId = runId;
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
// Steering events (AB-90 child ab90-01, dispatching AB-67's decision record)
//
// AB-67 fixes `SteeringCommandState`'s six values: `requested`, `accepted`,
// `applied`, `rejected`, `superseded`, `failed`. `requested` is never
// dispatched standalone — admission is synchronous validate-then-accept-or-
// reject, so it is satisfied by the transition into `accepted` or a
// pre-admission rejection outcome, never persisted or observed on its own —
// so there is no `SteeringRequestedEvent`. The remaining five transitions
// each get one event class below.
//
// This package dispatches ONLY `steering.applied`, from `runStep`
// (`run-step.ts`) at the AB-67/AB-198 boundary — the one steering
// transition operative's own code observes. `steering.accepted`,
// `steering.rejected`, `steering.superseded`, and `steering.failed` are
// admission/termination outcomes of Bureau's `submitSteeringCommand`
// (AB-199, Backlog); their classes are exported and added to
// `OperativeEventMap` here for that issue to dispatch against — this
// package does not synthesize an admission path or a durable command store.
//
// Durability classification, per AB-87's AC5 resolution: `steering.applied`
// is cursor-advancing (the durable aggregate sequence's authoritative
// steering marker, once wired through AB-91's `FleetEventFeed`);
// `steering.accepted` and the three terminal-failure events are not — they
// describe a desired-state transition, never a step boundary being crossed.
// ---------------------------------------------------------------------------

/**
 * Narrows {@link SteeringCommandFailure} to a subset of `reason` values.
 *
 * AB-236 makes `SteeringCommandFailure` a genuine discriminated union — one
 * member per `reason` (not one member grouping several reasons under a
 * multi-literal `reason` field) — specifically so `Extract<T, { reason: R
 * }>` narrows correctly here: each member's `reason` is a single literal,
 * so `member extends { reason: R }` is decided per member rather than
 * against one wide multi-literal field, and works whether `R` is a single
 * reason (`SteeringSupersededEvent`, below) or a subset
 * (`SteeringRejectedEvent`/`SteeringFailedEvent`). Before AB-236 this used
 * to reconstruct the shape via `Omit<SteeringCommandFailure, 'reason'> &
 * { reason: R }` instead, precisely because `Extract` did not narrow
 * correctly against the pre-AB-236 shape — but that reconstruction doesn't
 * distribute over a union either, so it silently lost the
 * `'superseded-by'`-only `supersededBy: string` requirement AB-236 added
 * (see the `DistributiveOmit` note on `scheduler/types.ts`'s
 * `SchedulerRunOptions` for the same non-distributivity, elsewhere).
 */
type SteeringFailureReason<R extends SteeringCommandFailure['reason']> = Extract<
  SteeringCommandFailure,
  { reason: R }
>;

/**
 * `requested` → `accepted`: a `SteeringCommand` was admitted and written
 * into the owning session's desired state. `configVersion` is the
 * post-increment value (AB-67: increments by exactly one on every command
 * that reaches `accepted`, whether or not it is ever applied). Not
 * cursor-advancing — see the block comment above.
 */
export class SteeringAcceptedEvent extends Event {
  static readonly type = 'steering.accepted' as const;
  readonly sessionId: string;
  readonly commandId: string;
  readonly configVersion: number;
  constructor(sessionId: string, commandId: string, configVersion: number) {
    super(SteeringAcceptedEvent.type);
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.configVersion = configVersion;
  }
}

/**
 * `accepted` → `applied`: dispatched by `runStep` the moment it observes an
 * accepted command's `configVersion` at its entry boundary — never mid-step.
 * `effective` is the exact `SteeringEffectiveState` (AB-67's shape, imported
 * verbatim) the boundary stamped onto the step; `sessionId` is carried
 * alongside it because `SteeringEffectiveState` itself carries no
 * `sessionId` field (see `SteeringGate.sessionId`'s doc comment). Fires at
 * most once per distinct `configVersion` a run observes — cursor-advancing.
 */
export class SteeringAppliedEvent extends Event {
  static readonly type = 'steering.applied' as const;
  readonly sessionId: string;
  readonly effective: SteeringEffectiveState;
  constructor(sessionId: string, effective: SteeringEffectiveState) {
    super(SteeringAppliedEvent.type);
    this.sessionId = sessionId;
    this.effective = effective;
  }
}

/**
 * `accepted` → `rejected`: a terminal-failure outcome for a command
 * invalidated after admission (authorization revoked, policy denial, or
 * deadline passed). Mutually exclusive with `applied`/`superseded`/`failed`
 * for the same command id. Not cursor-advancing.
 *
 * `failure` excludes `session-terminal` too, not just the two reasons owned
 * by a sibling event (`superseded-by`, always `SteeringSupersededEvent`;
 * `run-terminal`, always `SteeringFailedEvent`, pause/resume only):
 * `SteeringCommandState`'s own ratified vocabulary comment reserves
 * `session-terminal` exclusively for `failed` ("failed // terminal-failure:
 * SteeringCommandFailure.reason is 'session-terminal' or, pause/resume
 * only, 'run-terminal'") — a session going terminal before a command is
 * ever consumed is always `failed`, never `rejected`, so the two stay
 * mutually exclusive at the type level, not just by convention. `run-ambiguous`
 * is excluded for a different reason — it is a pre-admission rejection
 * outcome (a `SteeringCommand` that never reached `accepted`), never one of
 * this family's `accepted → X` transitions.
 */
export class SteeringRejectedEvent extends Event {
  static readonly type = 'steering.rejected' as const;
  readonly sessionId: string;
  readonly commandId: string;
  readonly failure: SteeringFailureReason<
    'authorization-revoked' | 'policy-denied' | 'deadline-passed'
  >;
  constructor(
    sessionId: string,
    commandId: string,
    failure: SteeringFailureReason<'authorization-revoked' | 'policy-denied' | 'deadline-passed'>,
  ) {
    super(SteeringRejectedEvent.type);
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.failure = failure;
  }
}

/**
 * `accepted` → `superseded`: a terminal-failure outcome for a command whose
 * `target` received a later command that was admitted first (AB-67:
 * last-desired-value-per-target wins; the earlier command is marked
 * `superseded`, never silently dropped). Mutually exclusive with
 * `applied`/`rejected`/`failed` for the same command id. Not
 * cursor-advancing.
 */
export class SteeringSupersededEvent extends Event {
  static readonly type = 'steering.superseded' as const;
  readonly sessionId: string;
  readonly commandId: string;
  /**
   * Narrowed to `reason: 'superseded-by'` — the only `SteeringCommandFailure`
   * variant a supersession ever produces (AB-67: "last-desired-value-per-target
   * wins" is always a same-target admission race, never a session/run/
   * authorization/policy/deadline outcome). Narrowing here, rather than
   * accepting the full union, makes a future admission implementation that
   * tries to supersede for the wrong reason a compile error instead of a
   * silently mislabeled event.
   */
  readonly failure: SteeringFailureReason<'superseded-by'>;
  constructor(
    sessionId: string,
    commandId: string,
    failure: SteeringFailureReason<'superseded-by'>,
  ) {
    super(SteeringSupersededEvent.type);
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.failure = failure;
  }
}

/**
 * `accepted` → `failed`: a terminal-failure outcome restricted to
 * `SteeringCommandFailure.reason: 'session-terminal'` (any command) or
 * `'run-terminal'` (pause/resume only, per AB-67). Mutually exclusive with
 * `applied`/`rejected`/`superseded` for the same command id. Not
 * cursor-advancing.
 *
 * `failure` is narrowed to exactly those two reasons (`Extract`, not the
 * full `SteeringCommandFailure` union) so the constructor itself enforces
 * what this docstring already claimed — a `policy-denied` or
 * `authorization-revoked` failure belongs on `SteeringRejectedEvent`, and
 * passing one here is now a compile error rather than a type-level no-op.
 */
export class SteeringFailedEvent extends Event {
  static readonly type = 'steering.failed' as const;
  readonly sessionId: string;
  readonly commandId: string;
  readonly failure: SteeringFailureReason<'session-terminal' | 'run-terminal'>;
  constructor(
    sessionId: string,
    commandId: string,
    failure: SteeringFailureReason<'session-terminal' | 'run-terminal'>,
  ) {
    super(SteeringFailedEvent.type);
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.failure = failure;
  }
}

// ---------------------------------------------------------------------------
// Event map: maps event type string to the Event subclass instance
//
// `OperativeEventClassMap` deliberately does NOT `extends EventMap`
// (`Record<string, Event>`, an index-signature type). A TypeScript object
// type that extends an index signature has its `keyof` collapse to `string`
// wherever any of its members were introduced by that signature (verified
// empirically against this TypeScript version: `interface X extends
// Record<string, Event> { a: Event }` gives `keyof X` = `string`, not `'a'`)
// — which would make `OPERATIVE_EVENT_TYPES`'s exhaustiveness check below
// vacuous (a `string`-typed `Exclude` can never surface a missing member).
// `OperativeEventMap` (below) re-adds `EventMap` for the callers that need
// it (`TypedEventTarget<OperativeEventMap>`, session-handle's emitter,
// `create-subagent-tool.ts`/`create-handoff-tool.ts`'s `emitter` param);
// every event-type addition still happens in exactly one place —
// `OperativeEventClassMap` — same discipline as before this split.
// ---------------------------------------------------------------------------

export interface OperativeEventClassMap {
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
  // Schedule definition/fire-terminal lifecycle (AB-223)
  [SchedulePausedEvent.type]: SchedulePausedEvent;
  [ScheduleResumedEvent.type]: ScheduleResumedEvent;
  [ScheduleCancelledEvent.type]: ScheduleCancelledEvent;
  [ScheduleFailedEvent.type]: ScheduleFailedEvent;
  [ScheduleCompletedEvent.type]: ScheduleCompletedEvent;
  // session.monitor loop events (D7)
  [SessionMonitorTickEvent.type]: SessionMonitorTickEvent;
  [SessionMonitorDoneEvent.type]: SessionMonitorDoneEvent;
  // Phase F — durable multi-agent transition events (C3 completeness rule)
  [ChildWorkflowStartedEvent.type]: ChildWorkflowStartedEvent;
  // AB-50 — child dispatch lifecycle correlation (started above; terminal below)
  [ChildWorkflowCompletedEvent.type]: ChildWorkflowCompletedEvent;
  [ChildWorkflowFailedEvent.type]: ChildWorkflowFailedEvent;
  [ChildWorkflowAbortedEvent.type]: ChildWorkflowAbortedEvent;
  [HandoffOccurredEvent.type]: HandoffOccurredEvent;
  [HumanWaitParkedEvent.type]: HumanWaitParkedEvent;
  // Steering (AB-90 child ab90-01, AB-67's decision record)
  [SteeringAcceptedEvent.type]: SteeringAcceptedEvent;
  [SteeringAppliedEvent.type]: SteeringAppliedEvent;
  [SteeringRejectedEvent.type]: SteeringRejectedEvent;
  [SteeringSupersededEvent.type]: SteeringSupersededEvent;
  [SteeringFailedEvent.type]: SteeringFailedEvent;
  // Child lifecycle (AB-90 child ab90-02, AB-222): terminal events
  // (completed/failed/aborted) are mapped above alongside child.started
  // (AB-50); this block adds only the two new members AB-222 itself
  // defines — reattached (typed, never dispatched until AB-53) and
  // progress (the SemanticProgress-carrying, non-cursor-advancing pulse).
  [ChildWorkflowReattachedEvent.type]: ChildWorkflowReattachedEvent;
  [ChildWorkflowProgressEvent.type]: ChildWorkflowProgressEvent;
}

/** The runtime-usable event map. See the block comment above the class map for why this exists separately. */
export interface OperativeEventMap extends OperativeEventClassMap, EventMap {}

export type OperativeEventType = Extract<keyof OperativeEventClassMap, string>;

/**
 * Every `OperativeEventType`, derived mechanically from each event class's
 * own `static readonly type` — never retyped by hand — so an entry can
 * never drift from `OperativeEventClassMap`'s actual property keys.
 */
export const OPERATIVE_EVENT_TYPES = [
  RunStartedEvent.type,
  StepStartedEvent.type,
  StepGeneratedEvent.type,
  ToolsExecutingEvent.type,
  ToolsExecutedEvent.type,
  StepCompletedEvent.type,
  RunCompletedEvent.type,
  RunErrorEvent.type,
  RunAbortedEvent.type,
  RunTripwireEvent.type,
  StepAbortedEvent.type,
  GenerateStartedEvent.type,
  GenerateCompletedEvent.type,
  GenerateErrorEvent.type,
  GenerateRetryEvent.type,
  ResponseValidatedEvent.type,
  ToolResultValidatedEvent.type,
  ContextCompactedEvent.type,
  ResponseSchemaFailedEvent.type,
  ElicitationRequestedEvent.type,
  ElicitationResolvedEvent.type,
  BackpressureAppliedEvent.type,
  BackpressureReleasedEvent.type,
  UsageAccumulatedEvent.type,
  BudgetThresholdEvent.type,
  BudgetExceededEvent.type,
  SessionSavedEvent.type,
  SessionLoadedEvent.type,
  SessionCreatedEvent.type,
  SessionDeletedEvent.type,
  ContextBudgetWarningEvent.type,
  ToolStartedBubbleEvent.type,
  ToolProgressBubbleEvent.type,
  ToolSettledBubbleEvent.type,
  ToolErrorBubbleEvent.type,
  ToolPolicyDeniedBubbleEvent.type,
  SessionRecoverEvent.type,
  SessionCancelEvent.type,
  SessionForkEvent.type,
  SessionSleepEvent.type,
  SessionSignalEvent.type,
  SessionUpdateEvent.type,
  SessionQueryEvent.type,
  AgentScheduledEvent.type,
  WakeupScheduledEvent.type,
  SchedulePausedEvent.type,
  ScheduleResumedEvent.type,
  ScheduleCancelledEvent.type,
  ScheduleFailedEvent.type,
  ScheduleCompletedEvent.type,
  SessionMonitorTickEvent.type,
  SessionMonitorDoneEvent.type,
  ChildWorkflowStartedEvent.type,
  ChildWorkflowCompletedEvent.type,
  ChildWorkflowFailedEvent.type,
  ChildWorkflowAbortedEvent.type,
  HandoffOccurredEvent.type,
  HumanWaitParkedEvent.type,
  SteeringAcceptedEvent.type,
  SteeringAppliedEvent.type,
  SteeringRejectedEvent.type,
  SteeringSupersededEvent.type,
  SteeringFailedEvent.type,
  ChildWorkflowReattachedEvent.type,
  ChildWorkflowProgressEvent.type,
] as const satisfies readonly OperativeEventType[];

/**
 * Compile-time-only exhaustiveness guard: fails `check-types` when a member
 * is added to `OperativeEventClassMap` (i.e. `OperativeEventType` grows)
 * without a matching entry in `OPERATIVE_EVENT_TYPES` above. `never` here
 * means the array is exhaustive; anything else is the list of missing
 * members, surfaced directly in the compiler error.
 */
type MissingOperativeEventTypes = Exclude<
  OperativeEventType,
  (typeof OPERATIVE_EVENT_TYPES)[number]
>;
const _assertOperativeEventTypesExhaustive: MissingOperativeEventTypes extends never
  ? true
  : [
      'OPERATIVE_EVENT_TYPES is missing a member added to OperativeEventClassMap:',
      MissingOperativeEventTypes,
    ] = true;
void _assertOperativeEventTypesExhaustive;

type ToolboxEventKey = Extract<keyof ToolboxEvents, string>;

type PrefixedToolboxEvents = {
  [K in ToolboxEventKey as `toolbox.${K}`]: ForwardedEvent;
};

/**
 * Prefixed conversation events, keyed over `ConversationActionType` (a
 * finite literal union conversationalist exports) rather than `keyof
 * ConversationEvents`. `ConversationEventMap` carries its own `[key:
 * string]: Event` index signature, which collapses `keyof` to `string` for
 * the same structural reason documented above `OperativeEventClassMap` —
 * mapping over that would produce an unbounded `` `conversation.${string}`
 * `` key, making conversation-side exhaustiveness unprovable. Every action
 * `ConversationActionType` lists is one `ConversationEventMap` already
 * declares as an explicit property, so this stays a faithful (and, unlike
 * `keyof ConversationEvents`, actually finite) key set.
 */
type PrefixedConversationEvents = {
  [K in ConversationActionType as `conversation.${K}`]: ForwardedEvent;
};

export interface ForwardedEvents extends PrefixedToolboxEvents, PrefixedConversationEvents {}

/**
 * Exported (unlike the private `OperativeEventClassMap` it mirrors) because
 * `EventRecorder.attach`'s default `TEventMap` needs a genuinely narrow-keyed
 * type to structurally match `ActiveRun.addEventListener`'s `K extends
 * CombinedOperativeEventType` bound — `CombinedOperativeEventMap` itself
 * cannot serve that role, since its own `keyof` is deliberately widened by
 * `extends EventMap` for `TypedEventTarget` compatibility (see the block
 * comment above `OperativeEventClassMap`).
 */
export interface CombinedOperativeEventClassMap extends OperativeEventClassMap, ForwardedEvents {}

export interface CombinedOperativeEventMap extends CombinedOperativeEventClassMap, EventMap {}

export type CombinedOperativeEventType = Extract<keyof CombinedOperativeEventClassMap, string>;

const TOOLBOX_EVENT_KEYS = [
  'call',
  'complete',
  'error',
  'not-found',
  'query',
  'search',
  'status:update',
  'execute-start',
  'validate-success',
  'validate-error',
  'execute-success',
  'execute-error',
  'settled',
  'policy-denied',
  'tool.started',
  'tool.finished',
  'budget-exceeded',
  'progress',
  'stream-start',
  'stream-chunk',
  'stream-end',
  'stream-error',
  'output-chunk',
  'log',
  'cancelled',
  'name-resolved',
  'loop-warning',
  'loop-blocked',
] as const satisfies readonly ToolboxEventKey[];

const CONVERSATION_ACTION_TYPES = [
  'push',
  'undo',
  'redo',
  'switch',
  'messages.appended',
  'messages.updated',
  'messages.removed',
  'tool-calls.appended',
  'tool-results.appended',
  'stream.started',
  'stream.updated',
  'stream.finalized',
  'stream.cancelled',
  'compaction.started',
  'compaction.completed',
  'compaction.failed',
  'compaction.cancelled',
  'compaction.stale-discarded',
  'mutation.rejected',
  'snapshot.restored',
  'snapshot.migrated',
  'branch.pruned',
  'controller.closed',
  'controller.disposed',
  'plugin.activated',
  'plugin.failed',
  'session.forked',
  'session.tagged',
  'session.renamed',
] as const satisfies readonly ConversationActionType[];

/**
 * Every `CombinedOperativeEventType`: `OPERATIVE_EVENT_TYPES` plus every
 * `toolbox.*`/`conversation.*` forwarded key, each hand-listed exactly once
 * (`TOOLBOX_EVENT_KEYS`/`CONVERSATION_ACTION_TYPES` above) because neither
 * `armorer` nor `conversationalist` exports a runtime key array for its
 * event map — see the coordinator note on `check-package-shape` tolerating
 * this as a type-only-adjacent value import.
 */
export const COMBINED_OPERATIVE_EVENT_TYPES = [
  ...OPERATIVE_EVENT_TYPES,
  ...TOOLBOX_EVENT_KEYS.map((key) => `toolbox.${key}` as const),
  ...CONVERSATION_ACTION_TYPES.map((key) => `conversation.${key}` as const),
] as const satisfies readonly CombinedOperativeEventType[];

type MissingCombinedOperativeEventTypes = Exclude<
  CombinedOperativeEventType,
  (typeof COMBINED_OPERATIVE_EVENT_TYPES)[number]
>;
const _assertCombinedOperativeEventTypesExhaustive: MissingCombinedOperativeEventTypes extends never
  ? true
  : [
      'COMBINED_OPERATIVE_EVENT_TYPES is missing a member added to CombinedOperativeEventClassMap:',
      MissingCombinedOperativeEventTypes,
    ] = true;
void _assertCombinedOperativeEventTypesExhaustive;

/**
 * The full public event-target surface accepted by durable routing. Listing
 * the public members explicitly avoids making consumers share lifecycle's
 * private class identity while still rejecting dispatch-only objects.
 */
export interface OperativeEventEmitter {
  readonly completed: boolean;
  readonly signal: AbortSignal;
  addEventListener<K extends CombinedOperativeEventType>(
    type: K,
    listener: ((event: CombinedOperativeEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends CombinedOperativeEventType>(
    type: K,
    listener: ((event: CombinedOperativeEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  dispatch<K extends CombinedOperativeEventType>(
    event: CombinedOperativeEventMap[K] & { type: K },
  ): boolean;
  dispatchEvent(event: Event): boolean;
  on<K extends CombinedOperativeEventType>(
    type: K,
    options?: { signal?: AbortSignal; bufferSize?: number },
  ): ObservableLike<CombinedOperativeEventMap[K]>;
  once<K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
  ): void;
  subscribe<K extends CombinedOperativeEventType>(
    type: K,
    observerOrNext?:
      Observer<CombinedOperativeEventMap[K]> | ((value: CombinedOperativeEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
  events<K extends CombinedOperativeEventType>(
    type: K,
    options?: { signal?: AbortSignal; bufferSize?: number },
  ): AsyncIterableIterator<CombinedOperativeEventMap[K]>;
  toObservable(): ObservableLike<CombinedOperativeEventMap[CombinedOperativeEventType]>;
  complete(): void;
}

// Backward-compatible aliases
export type OperativeEvents = {
  [K in keyof OperativeEventMap]: OperativeEventMap[K];
};
export type CombinedOperativeEvents = {
  [K in keyof CombinedOperativeEventMap]: CombinedOperativeEventMap[K];
};
