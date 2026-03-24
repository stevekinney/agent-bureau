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
 * Removes the `conversation` property from a record, returning a shallow copy
 * without it. Returns the original record when no `conversation` key is present.
 */
function stripConversation(record: Record<string, unknown>): Record<string, unknown> {
  if (!('conversation' in record)) return record;
  const { conversation: _, ...rest } = record;
  return rest;
}

/**
 * Converts an `error` property inside a record to a JSON-safe string.
 * `Error` instances are replaced with their `message`; other non-string
 * values are passed through `safeStringify`. Returns the original record
 * unchanged when no `error` key is present.
 */
function serializeError(record: Record<string, unknown>): Record<string, unknown> {
  if (!('error' in record)) return record;

  const { error, ...rest } = record;

  const serialized =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error !== undefined
          ? safeStringify(error)
          : undefined;

  return { ...rest, error: serialized };
}

/**
 * Strips non-serializable properties (e.g. Conversation instances, Error
 * objects) from action detail objects before they are sent over WebSocket.
 *
 * For `run.completed`, this strips the top-level `conversation` as well as
 * the nested `conversation` inside each element of the `steps` array
 * (each step is a `StepResult` which also holds a `Conversation` instance).
 *
 * For error events (`run.error`, `generate.error`, `generate.retry`), the
 * `error` property is serialized to a string so `Error` instances don't
 * collapse to `{}` under `JSON.stringify`.
 */
export function serializeActionDetail(eventType: string, detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') return detail;

  const record = detail as Record<string, unknown>;

  if (eventType === 'step.completed') {
    return stripConversation(record);
  }

  if (eventType === 'run.completed') {
    const stripped = stripConversation(record);

    if (Array.isArray(stripped['steps'])) {
      return {
        ...stripped,
        steps: (stripped['steps'] as Record<string, unknown>[]).map(stripConversation),
      };
    }

    return stripped;
  }

  if (
    eventType === 'run.error' ||
    eventType === 'generate.error' ||
    eventType === 'generate.retry'
  ) {
    return serializeError(record);
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
