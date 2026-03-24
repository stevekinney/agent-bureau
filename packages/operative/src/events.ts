import type { ToolboxEvents, ToolExecutionResult } from 'armorer';
import type { Conversation, ConversationEvents } from 'conversationalist';
import type { ToolCall } from 'interoperability';

import type { CostBudgetExceededEvent, CostBudgetThresholdEvent } from './cost-budget-monitor';
import type { GenerateResponse, RunResult, StepResult, TokenUsage } from './types';

/**
 * Event map for the operative agent loop.
 */
export interface OperativeEvents {
  'run.started': { conversation: Conversation };
  'step.started': { conversation: Conversation; step: number };
  'step.generated': {
    step: number;
    content: string;
    toolCalls: readonly ToolCall[];
    usage?: TokenUsage;
  };
  'tools.executing': { step: number; toolCalls: readonly ToolCall[] };
  'tools.executed': {
    step: number;
    toolCalls: readonly ToolCall[];
    results: readonly ToolExecutionResult[];
  };
  'step.completed': StepResult;
  'run.completed': RunResult;
  'run.error': { step: number; error: unknown };
  'run.aborted': { step: number; reason?: string };
  'step.aborted': { step: number; reason?: string };
  'generate.started': { step: number };
  'generate.completed': {
    step: number;
    response: GenerateResponse;
    durationMilliseconds: number;
  };
  'generate.error': { step: number; error: unknown; durationMilliseconds: number };
  'generate.retry': { step: number; attempt: number; error: unknown };
  'response.validated': {
    step: number;
    original: GenerateResponse;
    validated: GenerateResponse;
  };
  'tool-result.validated': {
    step: number;
    original: ToolExecutionResult;
    validated: ToolExecutionResult;
  };
  'context.compacted': { step: number; tokensBefore: number; tokensAfter: number };
  'response.schema-failed': {
    step: number;
    content: string;
    error: unknown;
    retriesRemaining: number;
  };
  'elicitation.requested': { step: number; message: string };
  'elicitation.resolved': { step: number; accepted: boolean };
  'backpressure.applied': { step: number; delay: number };
  'backpressure.released': { step: number };
  'usage.accumulated': { step: number; stepUsage?: TokenUsage; totalUsage: TokenUsage };
  'budget.threshold': CostBudgetThresholdEvent;
  'budget.exceeded': CostBudgetExceededEvent;
  'session.saved': { sessionId: string; agentName: string };
  'session.loaded': { sessionId: string; agentName: string };
}

export type OperativeEventType = keyof OperativeEvents;

type PrefixedToolboxEvents = {
  [K in keyof ToolboxEvents as `toolbox.${K & string}`]: ToolboxEvents[K];
};

type PrefixedConversationEvents = {
  [K in keyof ConversationEvents as `conversation.${K & string}`]: ConversationEvents[K];
};

export interface ForwardedEvents extends PrefixedToolboxEvents, PrefixedConversationEvents {}
export type CombinedOperativeEvents = OperativeEvents & ForwardedEvents;
export type CombinedOperativeEventType = keyof CombinedOperativeEvents;
