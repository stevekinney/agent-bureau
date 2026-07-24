import type { RunState } from '@lostgradient/operative/store';

import type { BureauDiagnostic, DiagnosticSink, RunDetail, RunSummary } from './types';

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

function serializeTrackedObject<T extends object>(
  value: T,
  seen: WeakSet<object>,
  serialize: () => unknown,
): unknown {
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  try {
    return serialize();
  } finally {
    seen.delete(value);
  }
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
    return serializeTrackedObject(value, seen, () =>
      Array.from(value.entries(), ([key, entry]) => [
        toJsonSafe(key, seen),
        toJsonSafe(entry, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    return serializeTrackedObject(value, seen, () =>
      Array.from(value.values(), (entry) => toJsonSafe(entry, seen)),
    );
  }

  if (Array.isArray(value)) {
    return serializeTrackedObject(value, seen, () => value.map((entry) => toJsonSafe(entry, seen)));
  }

  if (typeof value === 'object') {
    return serializeTrackedObject(value, seen, () => {
      if (hasToJson(value)) {
        return toJsonSafe(value.toJSON(), seen);
      }

      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        result[key] = toJsonSafe(entry, seen);
      }
      return result;
    });
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

// ── Diagnostics ──────────────────────────────────────────────────────

/**
 * Default diagnostic sink: writes to `console.error`/`console.warn`, exactly
 * matching bureau's pre-`onDiagnostic` console output — a two-argument call
 * (`message`, `cause`) when `cause` is present, a single-argument call
 * otherwise.
 */
function writeDiagnosticToConsole(diagnostic: BureauDiagnostic): void {
  const { level, message, cause } = diagnostic;
  if (cause !== undefined) {
    console[level](message, cause);
  } else {
    console[level](message);
  }
}

/**
 * Resolves a host-supplied {@link DiagnosticSink} into one that is always
 * safe to call: a throwing sink, or no sink at all, falls back to
 * {@link writeDiagnosticToConsole} so a diagnostic is never lost and a
 * misbehaving sink can never crash the runtime.
 */
export function resolveDiagnosticSink(onDiagnostic: DiagnosticSink | undefined): DiagnosticSink {
  if (!onDiagnostic) return writeDiagnosticToConsole;

  return (diagnostic) => {
    try {
      onDiagnostic(diagnostic);
    } catch {
      writeDiagnosticToConsole(diagnostic);
    }
  };
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
 * For `step.completed` and `run.aborted`, this strips the top-level
 * `conversation` field.
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

  if (eventType === 'step.completed' || eventType === 'run.aborted') {
    return toJsonSafe(stripConversation(record));
  }

  if (eventType === 'run.completed') {
    const stripped = stripConversation(record);

    if (Array.isArray(stripped['steps'])) {
      return toJsonSafe({
        ...stripped,
        steps: (stripped['steps'] as Record<string, unknown>[]).map(stripConversation),
      });
    }

    return toJsonSafe(stripped);
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
 * Best-effort agentName lookup for a run from its action log: the curated
 * `tool.*` bubble events (`ToolStartedBubbleEvent` et al.) stamp every action
 * with `{agentName, runId, step}`, so the first action carrying it tells us
 * the run's agent. `undefined` for a run with no tool activity yet.
 *
 * This is a fallback for runs whose deterministic `agentName` (resolved at
 * creation time from `CreateRunRequest.agentName`) is unavailable — namely a
 * run reattached after durable recovery, whose in-memory resolution was lost
 * to the process restart.
 */
export function findRunAgentName(runState: {
  actions: readonly { detail: unknown }[];
}): string | undefined {
  for (const action of runState.actions) {
    const detail = action.detail;
    if (
      detail !== null &&
      typeof detail === 'object' &&
      'agentName' in detail &&
      typeof (detail as { agentName: unknown }).agentName === 'string'
    ) {
      return (detail as { agentName: string }).agentName;
    }
  }
  return undefined;
}

/**
 * Run attribution resolved outside the operative store (AB-54 usage
 * analytics grouping): the agent and authenticated principal captured at
 * `createRun` time. Both are `undefined` when unresolved (e.g. a durably
 * recovered run whose in-memory attribution was lost to a process restart).
 */
export interface RunAttribution {
  agentName?: string;
  principal?: string;
}

/**
 * Maps a live RunState (which may contain non-serializable objects like
 * ActiveRun and Conversation) to a JSON-safe RunSummary DTO.
 *
 * `attribution` carries the agentName/principal resolved deterministically at
 * `createRun` time (see {@link RunAttribution}); when omitted (or its
 * `agentName` is unset), `agentName` falls back to the {@link findRunAgentName}
 * heuristic scan of the run's own action log.
 */
export function serializeRunState(
  runState: RunState,
  sessionId?: string,
  attribution?: RunAttribution,
): RunSummary {
  return {
    id: runState.id,
    sessionId: sessionId ?? '',
    status: runState.status,
    steps: runState.steps.length,
    usage: { ...runState.usage },
    finishReason: runState.finishReason,
    error: runState.error !== undefined ? serializeUnknownError(runState.error) : undefined,
    actionCount: runState.actions.length,
    agentName: attribution?.agentName ?? findRunAgentName(runState),
    principal: attribution?.principal,
    startedAt: runState.actions[0]?.timestamp,
  };
}

export function serializeRunDetail(
  runState: RunState,
  sessionId?: string,
  attribution?: RunAttribution,
): RunDetail {
  return {
    ...serializeRunState(runState, sessionId, attribution),
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
