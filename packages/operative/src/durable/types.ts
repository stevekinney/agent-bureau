import type { Toolbox, ToolExecutionResult } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import type { JSONValue, ToolCall } from 'interoperability';

import type { EventDispatcher } from '../run-step';
import type { RunOptions } from '../types';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; the durable layer never inspects the tool-tuple type parameter (matches gateway's GatewayToolbox).
type AnyToolbox = Toolbox<any>;

/**
 * A pending self-wakeup registered by the `scheduleWakeup` tool during a run.
 * When present after the main step loop exits, the `agentRun` workflow will
 * `yield* ctx.sleep(duration)` before completing — parking the durable run
 * until the timer fires.
 *
 * The `note` is appended to the conversation on wakeup so the agent knows why
 * it resumed (e.g. "Wake me up to check the deploy").
 */
export interface PendingWakeup {
  /**
   * How long to sleep. A Weft {@link Duration}: milliseconds (number) or
   * ISO-8601 / human-readable string (e.g. `'6h'`, `'PT30M'`, `'500ms'`).
   */
  duration: number | string;
  /** Optional note to surface when the run resumes after sleeping. */
  note?: string;
}

/**
 * A pending human-input gate registered by the `requestHumanInput` tool during
 * a run (F3 — HITL). When present after the main step loop exits, the
 * `agentRun` workflow will `yield* ctx.waitForSignal(signalName)` before
 * continuing — parking the durable run until a human sends the named signal via
 * `session.signal(runId, signalName, payload)`.
 */
export interface PendingHumanWait {
  /**
   * The signal name the run parks on. The human sends the same name when
   * releasing the run (e.g. `'human-response'`).
   */
  signalName: string;
  /** Optional prompt to surface to the human reviewer. */
  prompt?: string;
}

/**
 * The non-serializable, per-run behavior a durable workflow needs but cannot
 * checkpoint: the `generate` function, the `toolbox`, the hook registry, the
 * event emitter, and the other closures from {@link RunOptions}. Checkpoints
 * persist run *state* (cursor, transcript, step records); this is run *behavior*.
 *
 * It is handed to the durable `agentRun` workflow as Weft's per-run `services`
 * value (`engine.start(type, input, { services })`, read as `ctx.services`),
 * which is never checkpointed and is re-provided on cross-process recovery by
 * the engine's `resolveWorkflowServices` resolver.
 */
export interface DurableRunDeps {
  options: RunOptions;
  toolbox: AnyToolbox;
  /**
   * The event emitter the run's steps dispatch to. Present under inline mode so
   * the durable path emits the same `CombinedOperativeEventMap` events as the
   * in-memory loop (hooks/events parity); `undefined` for a headless durable run
   * with no observable surface.
   */
  emitter?: EventDispatcher;
  /**
   * A pending self-wakeup registered during this run by the `scheduleWakeup`
   * tool. When present after the main step loop exits, the workflow performs
   * `yield* ctx.sleep(duration)` to park until the timer fires.
   *
   * Mutable by the `scheduleWakeup` tool (which runs inside `ctx.memo`). Only
   * the LAST call wins — calling `scheduleWakeup` multiple times overwrites the
   * previous request. The workflow reads this exactly once, after the loop, so
   * it is never checkpointed (tools can safely mutate it in-process).
   */
  pendingWakeup?: PendingWakeup;
  /**
   * F3 — A pending human-input gate registered by the `requestHumanInput` tool.
   * When present after the main step loop exits, the workflow performs
   * `yield* ctx.waitForSignal(signalName)` to park until a human sends the
   * signal via `session.signal(runId, signalName, payload)`.
   *
   * Mutually exclusive with `pendingWakeup`; only the LAST assignment (either
   * wakeup or human-wait) governs parking. Mutable by the `requestHumanInput`
   * tool inside `ctx.memo`.
   */
  pendingHumanWait?: PendingHumanWait;
  /**
   * Optional plain metadata to persist with the committed step record after
   * `runStep` finishes. This runs immediately before `recordStep`, so the
   * returned data shares the step record's commit boundary.
   */
  getStepMetadata?: () => Record<string, JSONValue> | undefined;
}
