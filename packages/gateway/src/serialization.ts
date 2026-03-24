import type { RunState } from 'sentinel';

import type { RunSummary } from './types';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
