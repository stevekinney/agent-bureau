import type { ConversationHistory, JSONValue, TokenUsage } from 'conversationalist';
import { conversationSchema, jsonValueSchema, tokenUsageSchema } from 'conversationalist/schemas';
import { z } from 'zod';

import type { CostEstimate } from './cost-estimation';
import type { FinishReason } from './types';

/**
 * AB-96 — Serializable run envelope for out-of-process runners.
 *
 * `operative` is the owning package for the run envelope contract: it already
 * owns `RunResult`, `TokenUsage`, `CostEstimate`, and `FinishReason`, and the
 * envelope's terminal `RunReport` is built directly from a `RunResult`. Every
 * type here is plain-data (no class instances, no functions, no `Conversation`
 * objects) so `JSON.parse(JSON.stringify(frame))` round-trips exactly —
 * verified by `run-envelope.test.ts`.
 *
 * `RUN_ENVELOPE_SCHEMA_VERSION` is bumped whenever a breaking shape change is
 * made to `RunFrame` or `RunReport`. Consumers (e.g. an out-of-process runner
 * reading frames over a pipe or WebSocket) should branch on `schemaVersion`
 * rather than assume the current shape.
 */
export const RUN_ENVELOPE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Redacted tool input/output summaries
// ---------------------------------------------------------------------------

/** Keys treated as sensitive and redacted wholesale from a tool input/output summary. */
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|api[-_]?key|authorization|credential|private[-_]?key)/i;

const DEFAULT_MAX_STRING_LENGTH = 500;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_KEYS = 50;

export interface SummarizeOptions {
  /** Strings longer than this are truncated with a `…(N more chars)` marker. Default 500. */
  maxStringLength?: number;
  /** Nesting depth beyond which a value collapses to `'[truncated]'`. Default 4. */
  maxDepth?: number;
  /** Arrays longer than this are truncated with a trailing marker element. Default 20. */
  maxArrayItems?: number;
  /** Objects with more keys than this are truncated with a trailing marker key. Default 50. */
  maxObjectKeys?: number;
}

/**
 * Produces a redacted, size-bounded, JSON-safe summary of an arbitrary tool
 * input or output value — used for the `tool-pre`/`tool-post` frames so a
 * live stream never leaks secrets or unbounded payloads to an out-of-process
 * consumer.
 *
 * - Keys matching {@link SENSITIVE_KEY_PATTERN} (password, token, apiKey, ...)
 *   are replaced with `'[redacted]'` regardless of value type.
 * - Strings longer than `maxStringLength` are truncated.
 * - Nesting deeper than `maxDepth`, arrays longer than `maxArrayItems`, and
 *   objects with more than `maxObjectKeys` keys are truncated with a marker.
 * - Non-JSON values (functions, symbols, class instances without enumerable
 *   own properties beyond a plain object) degrade to a type-tagged string
 *   rather than throwing.
 */
export function summarizeToolInput(value: unknown, options: SummarizeOptions = {}): JSONValue {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayItems = options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS;
  const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;

  function truncateString(input: string): string {
    if (input.length <= maxStringLength) return input;
    return `${input.slice(0, maxStringLength)}…(${input.length - maxStringLength} more chars)`;
  }

  function summarize(input: unknown, depth: number, keyHint?: string): JSONValue {
    if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) return '[redacted]';

    if (input === null || input === undefined) return null;
    if (typeof input === 'string') return truncateString(input);
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return truncateString(input.toString());
    if (typeof input === 'function') return `[Function ${input.name || 'anonymous'}]`;
    if (typeof input === 'symbol') return truncateString(input.toString());

    if (depth >= maxDepth) return '[truncated]';

    if (Array.isArray(input)) {
      const items = input.slice(0, maxArrayItems).map((entry) => summarize(entry, depth + 1));
      if (input.length > maxArrayItems) {
        items.push(`…(${input.length - maxArrayItems} more items)`);
      }
      return items;
    }

    if (input instanceof Error) return truncateString(input.message);
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString();
    }

    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>);
      const result: Record<string, JSONValue> = {};
      for (const [key, entryValue] of entries.slice(0, maxObjectKeys)) {
        result[key] = summarize(entryValue, depth + 1, key);
      }
      if (entries.length > maxObjectKeys) {
        result['…'] = `(${entries.length - maxObjectKeys} more keys)`;
      }
      return result;
    }

    // Every `typeof` branch (string, number, boolean, bigint, function,
    // symbol, object, undefined) is handled above — this is unreachable in
    // practice, but `input: unknown` means TypeScript can't prove it.
    return '[unknown]';
  }

  return summarize(value, 0);
}

// ---------------------------------------------------------------------------
// RunFrame — the versioned, JSON-serializable event frame
// ---------------------------------------------------------------------------

const frameBaseSchema = z.object({
  schemaVersion: z.literal(RUN_ENVELOPE_SCHEMA_VERSION),
  runId: z.string(),
  timestamp: z.number(),
});

export const toolStatusSchema = z.enum(['success', 'error', 'denied', 'cancelled', 'paused']);
export type ToolFrameStatus = z.infer<typeof toolStatusSchema>;

export const notificationLevelSchema = z.enum(['info', 'warning', 'error']);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/** Terminal status for a {@link RunReport}. */
export const runReportStatusSchema = z.enum(['succeeded', 'failed', 'aborted', 'budget_stopped']);
export type RunReportStatus = z.infer<typeof runReportStatusSchema>;

const costEstimateSchema = z.object({
  promptCost: z.number(),
  completionCost: z.number(),
  cacheWriteCost: z.number(),
  cacheReadCost: z.number(),
  totalCost: z.number(),
  model: z.string(),
  usage: tokenUsageSchema,
}) satisfies z.ZodType<CostEstimate>;

/**
 * The terminal, JSON-serializable summary of a completed (or partially-
 * completed, on abrupt shutdown) run. Emitted for every exit path —
 * `succeeded` (stop-condition / maximum-steps), `failed` (error /
 * elicitation-denied), `aborted`, and `budget_stopped` (budget-exceeded).
 *
 * `transcript` is conversationalist's plain-object `ConversationHistory`
 * (AB-98) — already JSON-safe, no `Conversation` class instance. The type is
 * hand-written (rather than `z.infer`d) so it carries `ConversationHistory`'s
 * own readonly field types instead of a fresh, structurally-similar-but-
 * mutable shape reconstructed by `z.object()`.
 */
export interface RunReport {
  schemaVersion: typeof RUN_ENVELOPE_SCHEMA_VERSION;
  runId: string;
  status: RunReportStatus;
  finishReason?: string | undefined;
  usage: TokenUsage;
  costEstimate?: CostEstimate | undefined;
  effectiveModel?: string | undefined;
  effectiveEffort?: string | undefined;
  structuredOutput?: JSONValue | undefined;
  error?: string | undefined;
  transcript?: ConversationHistory | undefined;
}

/**
 * Zod schema for the terminal {@link RunReport}. `structuredOutput` is a
 * generic `jsonValueSchema` — the run's `responseSchema` shape is caller-
 * defined, so the envelope only guarantees JSON-safety, not the caller's
 * specific structured-output schema.
 */
export const runReportSchema = z.object({
  schemaVersion: z.literal(RUN_ENVELOPE_SCHEMA_VERSION),
  runId: z.string(),
  status: runReportStatusSchema,
  finishReason: z.string().optional(),
  usage: tokenUsageSchema,
  costEstimate: costEstimateSchema.optional(),
  effectiveModel: z.string().optional(),
  effectiveEffort: z.string().optional(),
  structuredOutput: jsonValueSchema.optional(),
  error: z.string().optional(),
  transcript: conversationSchema.optional(),
}) satisfies z.ZodType<RunReport>;

const runStartedFrameSchema = frameBaseSchema.extend({
  type: z.literal('run-started'),
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
});

const stepFrameSchema = frameBaseSchema.extend({
  type: z.literal('step'),
  step: z.number().int().min(0),
  phase: z.enum(['started', 'completed']),
  usage: tokenUsageSchema.optional(),
});

const assistantChunkFrameSchema = frameBaseSchema.extend({
  type: z.literal('assistant-chunk'),
  step: z.number().int().min(0),
  delta: z.string(),
  accumulated: z.string(),
});

const assistantFinalFrameSchema = frameBaseSchema.extend({
  type: z.literal('assistant-final'),
  step: z.number().int().min(0),
  content: z.string(),
});

const toolPreFrameSchema = frameBaseSchema.extend({
  type: z.literal('tool-pre'),
  step: z.number().int().min(0),
  toolCallId: z.string(),
  toolName: z.string(),
  inputSummary: jsonValueSchema,
});

const toolPostFrameSchema = frameBaseSchema.extend({
  type: z.literal('tool-post'),
  step: z.number().int().min(0),
  toolCallId: z.string(),
  toolName: z.string(),
  status: toolStatusSchema,
  durationMs: z.number().optional(),
  resultSummary: jsonValueSchema.optional(),
  error: z.string().optional(),
});

const notificationFrameSchema = frameBaseSchema.extend({
  type: z.literal('notification'),
  step: z.number().int().min(0).optional(),
  level: notificationLevelSchema,
  code: z.string(),
  message: z.string(),
});

const runFinishedFrameSchema = frameBaseSchema.extend({
  type: z.literal('run-finished'),
  report: runReportSchema,
}) satisfies z.ZodType<RunFinishedFrame>;

/**
 * Discriminated union of every versioned run-lifecycle frame. Every variant
 * is JSON-safe by construction — no `Conversation`/`Error`/`Date` instances,
 * only plain data — and round-trips through `JSON.parse(JSON.stringify(x))`.
 */
export const runFrameSchema = z.discriminatedUnion('type', [
  runStartedFrameSchema,
  stepFrameSchema,
  assistantChunkFrameSchema,
  assistantFinalFrameSchema,
  toolPreFrameSchema,
  toolPostFrameSchema,
  notificationFrameSchema,
  runFinishedFrameSchema,
]) satisfies z.ZodType<RunFrame>;

export type RunStartedFrame = z.infer<typeof runStartedFrameSchema>;
export type StepFrame = z.infer<typeof stepFrameSchema>;
export type AssistantChunkFrame = z.infer<typeof assistantChunkFrameSchema>;
export type AssistantFinalFrame = z.infer<typeof assistantFinalFrameSchema>;
export type ToolPreFrame = z.infer<typeof toolPreFrameSchema>;
export type ToolPostFrame = z.infer<typeof toolPostFrameSchema>;
export type NotificationFrame = z.infer<typeof notificationFrameSchema>;

/**
 * Hand-written (not `z.infer`d) so `report.transcript` carries
 * `ConversationHistory`'s own readonly field types — see {@link RunReport}.
 */
export interface RunFinishedFrame {
  schemaVersion: typeof RUN_ENVELOPE_SCHEMA_VERSION;
  type: 'run-finished';
  runId: string;
  timestamp: number;
  report: RunReport;
}

/**
 * Discriminated union of every versioned run-lifecycle frame. Every variant
 * is JSON-safe by construction — no `Conversation`/`Error`/`Date` instances,
 * only plain data — and round-trips through `JSON.parse(JSON.stringify(x))`.
 */
export type RunFrame =
  | RunStartedFrame
  | StepFrame
  | AssistantChunkFrame
  | AssistantFinalFrame
  | ToolPreFrame
  | ToolPostFrame
  | NotificationFrame
  | RunFinishedFrame;

// ---------------------------------------------------------------------------
// Frame constructors
// ---------------------------------------------------------------------------

function now(clock?: () => number): number {
  return clock ? clock() : Date.now();
}

export function createRunStartedFrame(
  input: { runId: string; sessionId?: string; agentName?: string },
  clock?: () => number,
): RunStartedFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'run-started',
    runId: input.runId,
    sessionId: input.sessionId,
    agentName: input.agentName,
    timestamp: now(clock),
  };
}

export function createStepFrame(
  input: { runId: string; step: number; phase: 'started' | 'completed'; usage?: TokenUsage },
  clock?: () => number,
): StepFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'step',
    runId: input.runId,
    step: input.step,
    phase: input.phase,
    usage: input.usage,
    timestamp: now(clock),
  };
}

export function createAssistantChunkFrame(
  input: { runId: string; step: number; delta: string; accumulated: string },
  clock?: () => number,
): AssistantChunkFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'assistant-chunk',
    runId: input.runId,
    step: input.step,
    delta: input.delta,
    accumulated: input.accumulated,
    timestamp: now(clock),
  };
}

export function createAssistantFinalFrame(
  input: { runId: string; step: number; content: string },
  clock?: () => number,
): AssistantFinalFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'assistant-final',
    runId: input.runId,
    step: input.step,
    content: input.content,
    timestamp: now(clock),
  };
}

export function createToolPreFrame(
  input: {
    runId: string;
    step: number;
    toolCallId: string;
    toolName: string;
    params: unknown;
    summarizeOptions?: SummarizeOptions;
  },
  clock?: () => number,
): ToolPreFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'tool-pre',
    runId: input.runId,
    step: input.step,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    inputSummary: summarizeToolInput(input.params, input.summarizeOptions),
    timestamp: now(clock),
  };
}

export function createToolPostFrame(
  input: {
    runId: string;
    step: number;
    toolCallId: string;
    toolName: string;
    status: ToolFrameStatus;
    durationMs?: number;
    result?: unknown;
    error?: unknown;
    summarizeOptions?: SummarizeOptions;
  },
  clock?: () => number,
): ToolPostFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'tool-post',
    runId: input.runId,
    step: input.step,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    durationMs: input.durationMs,
    resultSummary:
      input.result !== undefined
        ? summarizeToolInput(input.result, input.summarizeOptions)
        : undefined,
    error: input.error !== undefined ? stringifyError(input.error) : undefined,
    timestamp: now(clock),
  };
}

export function createNotificationFrame(
  input: { runId: string; step?: number; level: NotificationLevel; code: string; message: string },
  clock?: () => number,
): NotificationFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'notification',
    runId: input.runId,
    step: input.step,
    level: input.level,
    code: input.code,
    message: input.message,
    timestamp: now(clock),
  };
}

export function createRunFinishedFrame(
  input: { runId: string; report: RunReport },
  clock?: () => number,
): RunFinishedFrame {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    type: 'run-finished',
    runId: input.runId,
    report: input.report,
    timestamp: now(clock),
  };
}

// ---------------------------------------------------------------------------
// RunReport construction
// ---------------------------------------------------------------------------

/** Stringifies an arbitrary caught value into the `RunReport.error` string field. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return 'null';
  try {
    return JSON.stringify(error) ?? '[unserializable error]';
  } catch {
    return '[unserializable error]';
  }
}

/** Coerces an arbitrary value to a JSON-safe value, or `undefined` if it can't round-trip. */
function toJsonSafeOrUndefined(value: unknown): JSONValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return undefined;
  }
}

/**
 * Maps a loop {@link FinishReason} to the envelope's coarser {@link
 * RunReportStatus}. `stop-condition` and `maximum-steps` both count as a
 * successful exit; `elicitation-denied`, `error`, and `tripwire` (a guardrail
 * hard-halt — see AB-40) are all `'failed'`; `budget-exceeded` gets its own
 * status so a budget-triggered stop is distinguishable from a genuine
 * failure; `aborted` maps directly.
 */
export function mapFinishReasonToStatus(finishReason: FinishReason): RunReportStatus {
  switch (finishReason) {
    case 'stop-condition':
    case 'maximum-steps':
      return 'succeeded';
    case 'aborted':
      return 'aborted';
    case 'budget-exceeded':
      return 'budget_stopped';
    case 'elicitation-denied':
    case 'error':
    case 'tripwire':
      return 'failed';
    default: {
      const exhaustive: never = finishReason;
      return exhaustive;
    }
  }
}

export interface BuildRunReportInput {
  runId: string;
  status: RunReportStatus;
  finishReason?: FinishReason;
  usage: TokenUsage;
  costEstimate?: CostEstimate;
  effectiveModel?: string;
  effectiveEffort?: string;
  structuredOutput?: unknown;
  error?: unknown;
  transcript?: ConversationHistory;
}

/**
 * Builds a JSON-safe {@link RunReport} from the pieces the loop (or a partial
 * accumulator on abrupt shutdown) has available. `structuredOutput` is passed
 * through a JSON round-trip and silently dropped (not thrown) if it can't
 * serialize — the report itself must always be constructible.
 */
export function buildRunReport(input: BuildRunReportInput): RunReport {
  return {
    schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
    runId: input.runId,
    status: input.status,
    finishReason: input.finishReason,
    usage: input.usage,
    costEstimate: input.costEstimate,
    effectiveModel: input.effectiveModel,
    effectiveEffort: input.effectiveEffort,
    structuredOutput: toJsonSafeOrUndefined(input.structuredOutput),
    error: input.error !== undefined ? stringifyError(input.error) : undefined,
    transcript: input.transcript,
  };
}
