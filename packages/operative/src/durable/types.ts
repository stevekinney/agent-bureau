import type { ToolExecutionResult } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import type { JSONValue, ToolCall } from 'interoperability';

/**
 * The durable cursor for a run. This is the minimal plain-cloneable state the
 * durable workflow generator carries across a `yield*` checkpoint boundary.
 *
 * It deliberately holds NO `Conversation` instance — only the step index plus
 * the run-level accumulators. The conversation transcript is persisted
 * separately as a {@link ConversationSnapshot} (a `structuredClone`-safe tree),
 * because a `Conversation` class instance with prototype methods fails Weft's
 * `validateCloneable` check if it crosses a yield.
 *
 * The accumulators (`totalUsage`, `lastContent`, `schemaAttempts`) mirror the
 * run-scoped locals of the in-memory `executeLoop` so a resumed run continues
 * with the same usage totals and schema-retry budget rather than silently
 * resetting them to zero. They are exactly the plain half of `RunState` (its
 * `steps: StepResult[]` array — which embeds live `Conversation` instances — is
 * never carried across a yield; per-step records are persisted instead).
 */
export interface RunCursor {
  /** Zero-based index of the next step to execute. */
  step: number;
  /** Accumulated token usage across all completed steps. */
  totalUsage: { prompt: number; completion: number; total: number };
  /** Content of the most recent assistant turn. */
  lastContent: string;
  /** Run-scoped count of structured-output schema retries already consumed. */
  schemaAttempts: number;
}

/**
 * A plain, cloneable projection of a single completed step.
 *
 * Mirrors the public {@link import('../types').StepResult} shape but OMITS the
 * `conversation: Conversation` field — that instance is not serializable and is
 * persisted once per run as a {@link ConversationSnapshot} rather than per step.
 */
export interface StepRecord {
  step: number;
  content: string;
  toolCalls: readonly ToolCall[];
  results: readonly ToolExecutionResult[];
  usage?: { prompt: number; completion: number; total: number };
  metadata?: Record<string, JSONValue>;
  final: boolean;
}

/**
 * The complete durable checkpoint for a run, assembled from the individually
 * persisted pieces (cursor, transcript snapshot, per-step records).
 *
 * This is what {@link import('./checkpoint-store').CheckpointStore.loadCheckpoint}
 * returns and what a recovered run is rehydrated from.
 */
export interface RunCheckpoint {
  runId: string;
  cursor: RunCursor;
  /** Snapshot of the run-scoped conversation transcript, or `null` if none persisted yet. */
  conversation: ConversationSnapshot | null;
  /** Completed step records in step order. */
  steps: StepRecord[];
}
