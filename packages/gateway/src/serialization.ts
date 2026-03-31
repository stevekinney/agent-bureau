import type { RunState } from 'sentinel';

import type { RunDetail, RunSummary } from './types';

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasToJson(value: object): value is object & { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Map) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return Array.from(value.entries(), ([key, entry]) => [
      toJsonSafe(key, seen),
      toJsonSafe(entry, seen),
    ]);
  }

  if (value instanceof Set) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return Array.from(value.values(), (entry) => toJsonSafe(entry, seen));
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return value.map((entry) => toJsonSafe(entry, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    if (hasToJson(value)) {
      return toJsonSafe(value.toJSON(), seen);
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] = toJsonSafe(entry, seen);
    }
    return result;
  }

  return safeStringify(value);
}

export function serializeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error === null || error === undefined) {
    return 'null';
  }

  return safeStringify(toJsonSafe(error));
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

  const serialized = error !== undefined ? serializeUnknownError(error) : undefined;

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
    return toJsonSafe(serializeError(record));
  }

  return toJsonSafe(detail);
}

/**
 * Maps a live RunState (which may contain non-serializable objects like
 * ActiveRun and Conversation) to a JSON-safe RunSummary DTO.
 */
export function serializeRunState(runState: RunState, sessionId?: string): RunSummary {
  return {
    id: runState.id,
    sessionId: sessionId ?? '',
    status: runState.status,
    steps: runState.steps.length,
    usage: {
      prompt: runState.usage.prompt,
      completion: runState.usage.completion,
      total: runState.usage.total,
    },
    finishReason: runState.finishReason,
    error: runState.error !== undefined ? serializeUnknownError(runState.error) : undefined,
    actionCount: runState.actions.length,
  };
}

export function serializeRunDetail(runState: RunState, sessionId?: string): RunDetail {
  return {
    ...serializeRunState(runState, sessionId),
    events: runState.actions.map((action) => ({
      sequence: action.sequence,
      runId: action.runId,
      event: action.type,
      detail: serializeActionDetail(action.type, action.detail),
      timestamp: action.timestamp,
    })),
    stepDetails: runState.steps.map((step) => ({
      step: step.step,
      content: step.content,
      final: step.final,
      usage: step.usage,
      toolCalls: step.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toJsonSafe(toolCall.arguments),
      })),
      results: step.results.map((result) => ({
        toolName: result.toolName,
        result: toJsonSafe(result.result),
        error:
          result.error?.message ??
          result.errorMessage ??
          (typeof result.error === 'string' ? result.error : undefined),
      })),
    })),
    latestSnapshot: runState.snapshots.at(-1),
  };
}
