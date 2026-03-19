import type { Conversation } from 'conversationalist';
import type { ToolCall } from 'interoperability';

import type { ToolExecutionResult } from 'armorer';

import type { RunResult, StepResult, TokenUsage } from './types';

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
}

export type OperativeEventType = keyof OperativeEvents;
