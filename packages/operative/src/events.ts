import type { ToolboxEvents, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationEvents } from 'conversationalist';
import type { ToolCall } from 'interoperability';
import type { EventMap, ForwardedEvent } from 'lifecycle';

import type { CostBudgetExceededEvent, CostBudgetThresholdEvent } from './cost-budget-monitor';
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
  constructor(data: RunResult) {
    super(RunCompletedEvent.type);
    this.conversation = data.conversation;
    this.steps = data.steps;
    this.content = data.content;
    this.usage = data.usage;
    this.finishReason = data.finishReason;
    this.error = data.error;
    this.schemaValidation = data.schemaValidation;
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
  constructor(step: number, reason?: string) {
    super(RunAbortedEvent.type);
    this.step = step;
    this.reason = reason;
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
  constructor(step: number, attempt: number, error: unknown) {
    super(GenerateRetryEvent.type);
    this.step = step;
    this.attempt = attempt;
    this.error = error;
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
  constructor(step: number, totalUsage: TokenUsage, stepUsage?: TokenUsage) {
    super(UsageAccumulatedEvent.type);
    this.step = step;
    this.stepUsage = stepUsage;
    this.totalUsage = totalUsage;
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
  [ContextBudgetWarningEvent.type]: ContextBudgetWarningEvent;
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

// Backward-compatible aliases
export type OperativeEvents = {
  [K in keyof OperativeEventMap]: OperativeEventMap[K];
};
export type CombinedOperativeEvents = {
  [K in keyof CombinedOperativeEventMap]: CombinedOperativeEventMap[K];
};
