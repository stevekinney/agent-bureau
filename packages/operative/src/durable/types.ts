import type { AnyToolbox, ToolExecutionResult } from 'armorer';
import type { ConversationSnapshot, MultiModalContent } from 'conversationalist';
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
  /**
   * The workflow version identifier this run was created under (see
   * {@link import('./run-workflow').createRunWorkflow}'s `version` option),
   * stamped once at run creation and carried unchanged across every subsequent
   * cursor update. `undefined` for a run created before workflow versioning
   * existed, or when no version was configured for the engine that started it —
   * always treated as compatible (no mismatch is ever reported when either side
   * of a comparison is unset). See {@link import('./create-run-engine').CreateRunEngineOptions.runWorkflowVersion}
   * for how this is compared against the currently-registered version on
   * recovery.
   */
  workflowVersion?: string;
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

// AB-42 — session-input admission and delivery semantics. Type-only: these
// types fix the request, receipt, and state-transition shapes for
// `submitSessionInput` (AB-42's illustrative name; the runtime method itself is
// `ab-42-bureau-a`/`ab-42-bureau-b`'s scope, not this file's). No runtime
// behavior is attached here. See AB-42's decision record and
// `documentation/operative-type-safe-api.md`'s "Session input admission"
// section for the full contract these types participate in.

/** How an admitted {@link SessionInputRecord} is delivered to the session. */
export type SessionInputDeliveryMode = 'steer' | 'queue';

/** The message-shaped subset of the document's `AgentInput` this contract accepts: exactly
 *  what one `Message.content` can hold (`string | ReadonlyArray<MultiModalContent>`, matching
 *  `packages/conversationalist/src/types.ts:140`). The `{ conversation }` variant of `AgentInput`
 *  is out of scope for session-input admission; a caller with a full conversation to inject uses
 *  Bureau's conversation-replacement surface. AB-70 owns any future widening of the multimodal
 *  content within this message-shaped constraint. */
export type SessionInputPayload = string | ReadonlyArray<MultiModalContent>;

export interface SessionInputRecord<TPayload = SessionInputPayload> {
  /** Caller-supplied idempotency identity, or server-generated when the caller omits one. */
  readonly id: string;
  readonly idOrigin: 'caller' | 'generated';
  readonly sessionId: string;
  /** Authenticated sender. Required, unlike `StartedWorkIdentity.owner`. */
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: TPayload;
  /** Content-addressed digest of the canonicalized payload; part of the idempotency binding. */
  readonly payloadDigest: string;
  readonly admittedAt: string; // ISO
  /** The record's own eligibility deadline. Absent means no deadline. Distinct from
   *  post-terminal retention, which the document's line 569 rule governs separately. */
  readonly expiresAt?: string; // ISO
  /** Present only when admitted as an explicit successor to a still-pending input. Never inferred. */
  readonly supersedes?: string;
}

/** Caller-facing admission request. `SessionInputRecord` is the persisted, server-computed shape
 *  (`idOrigin`, `payloadDigest`, `admittedAt` are assigned by admission). `principal` is included
 *  here, matching `BureauRunOptions.principal`'s placement; the calling layer (the gateway's
 *  `resolvePrincipal(context)`, `hooks.ts:152`) attaches it from the authenticated request. The
 *  gateway body schema for `POST /sessions/:id/input` is `Omit<SessionInputAdmissionRequest,
 *  'principal'>`; a body-supplied `principal` is never trusted. */
export interface SessionInputAdmissionRequest<TPayload = SessionInputPayload> {
  readonly id?: string;
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: TPayload;
  readonly expiresAt?: string; // ISO
  readonly supersedes?: string;
}

// Illustrative: submitSessionInput(sessionId: string, request: SessionInputAdmissionRequest): Promise<SessionInputAdmissionOutcome>

export interface SessionInputReceipt {
  readonly id: string;
  readonly sessionId: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  /** Server-assigned per-session FIFO position, distinct from `revision`. */
  readonly admissionSequence: number;
  readonly revision: number;
  readonly state: SessionInputState;
  readonly admittedAt: string;
}

export interface SessionInputConflict {
  readonly id: string;
  readonly reason: 'session-mismatch' | 'delivery-mode-mismatch' | 'payload-mismatch';
  readonly originalReceipt: SessionInputReceipt;
}

export type SessionInputAdmissionOutcome =
  | { readonly outcome: 'admitted'; readonly receipt: SessionInputReceipt }
  | { readonly outcome: 'replayed'; readonly receipt: SessionInputReceipt }
  | { readonly outcome: 'conflict'; readonly conflict: SessionInputConflict }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'session-terminal'; readonly sessionId: string }
  | { readonly outcome: 'unsupported-capability'; readonly reason: string }
  | {
      readonly outcome: 'backlog-exhausted';
      readonly scope: 'session' | 'principal';
      readonly limit: number;
    };

export type SessionInputState =
  | 'accepted' // admitted, `steer` mode, waiting for the next safe boundary
  | 'queued' // admitted, `queue` mode, waiting for FIFO turn
  | 'promoted' // terminal-success: model-visible message and record committed together
  | 'rejected' // terminal-failure: authorization revoked, or session went terminal, after admission
  | 'expired' // terminal-failure: the input's own eligibility deadline passed before promotion
  | 'superseded' // terminal-failure: explicitly replaced by a named successor before promotion
  | 'canceled' // terminal-failure: caller or session-owner canceled before promotion
  | 'failed'; // terminal-failure: promotion was attempted and the session could not consume it

export interface SessionInputPromotion {
  readonly promotedAt: string; // ISO
  readonly conversationMessageId: string; // the message this input became
  /** Ordinal of the provider-turn boundary this input was consumed at. AB-67 owns the boundary's definition. */
  readonly providerTurn: number;
}

/** Populated on every terminal-failure `SessionInputState`. */
export interface SessionInputFailure {
  readonly failedAt: string; // ISO
  readonly reason:
    | 'session-terminal'
    | 'authorization-revoked'
    | 'deadline-passed'
    | 'superseded-by' // pairs with `SessionInputRecord.supersedes` on the successor
    | 'caller-canceled'
    | 'promotion-failed';
}
