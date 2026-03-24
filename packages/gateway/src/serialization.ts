import type { RunState } from 'sentinel';

import type { RunSummary } from './types';

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Strips non-serializable properties (e.g. Conversation instances) from
 * action detail objects before they are sent over WebSocket.
 */
export function serializeActionDetail(eventType: string, detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') return detail;

  const record = detail as Record<string, unknown>;

  if (
    (eventType === 'step.completed' || eventType === 'run.completed') &&
    'conversation' in record
  ) {
    const { conversation: _, ...rest } = record;
    // StepResult also nests conversation in results[].conversation — but
    // ToolExecutionResult doesn't have one, so a shallow strip is sufficient.
    return rest;
  }

  return detail;
}

/**
 * Maps a live RunState (which may contain non-serializable objects like
 * ActiveRun and Conversation) to a JSON-safe RunSummary DTO.
 */
export function serializeRunState(runState: RunState): RunSummary {
  return {
    id: runState.id,
    status: runState.status,
    steps: runState.steps.length,
    usage: {
      prompt: runState.usage.prompt,
      completion: runState.usage.completion,
      total: runState.usage.total,
    },
    finishReason: runState.finishReason,
    error:
      runState.error instanceof Error
        ? runState.error.message
        : runState.error !== undefined
          ? safeStringify(runState.error)
          : undefined,
    actionCount: runState.actions.length,
  };
}
