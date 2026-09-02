import type { AnyToolbox, ToolExecutionResult } from 'armorer';
import type {
  ConversationSnapshot,
  DocumentContent,
  ImageContent,
  TextContent,
} from 'conversationalist';
import type { JSONValue, ToolCall } from 'interoperability';

import type { Effort } from '../providers/types';
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
 * `yield* ctx.sleep(duration)` — parking the durable run until the timer
 * fires. Per AB-41's ratified decision record, once the timer fires the
 * workflow CONTINUES the same run with one more agent generation step
 * (AB-45); it never merely delays terminal completion.
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

/** The subset of `MultiModalContent` (`packages/conversationalist/src/multi-modal.ts`) a caller
 *  may submit as session input: `TextContent` (citation metadata omitted — see below),
 *  `ImageContent`, and `DocumentContent`. An explicit allowlist, not `Exclude<MultiModalContent,
 *  ...>` against the provider-generated/response-only kinds (`ThinkingContent`,
 *  `RedactedThinkingContent`, `ServerToolUseContent`, `WebSearchToolResultContent`,
 *  `ServerToolResultContent`, `ContainerUploadContent`): `conversationalist` is consumed at a
 *  `^` semver range, and a blacklist silently admits any new `MultiModalContent` variant a future
 *  compatible release adds, defeating AB-70's ownership of widening this union deliberately. Every
 *  excluded kind is either rejected outright (the Anthropic adapter throws serializing
 *  `container_upload` and the other response-only blocks as request content), silently dropped
 *  (the OpenAI and Gemini adapters serialize only text, document, and image content), or
 *  misattributed if replayed as if the user had sent it. AB-42's coordinator amendments
 *  (2026-09-02) own this exclusion; AB-70 owns any future widening.
 *
 *  The text branch forbids `citations` structurally (`citations?: never`), not merely via
 *  `Omit<TextContent, 'citations'>`: because TypeScript is structurally typed, `Omit<>` alone
 *  only drops the property requirement — a caller holding a value already typed as `TextContent`
 *  (with `citations` set) is still assignable to `Omit<TextContent, 'citations'>`, since excess
 *  properties on a non-literal source go unchecked. `citations?: never` makes any non-`undefined`
 *  `citations` a type error at every call site, literal or not. */
export type UserAdmissibleContent =
  | (Omit<TextContent, 'citations'> & { readonly citations?: never })
  | ImageContent
  | DocumentContent;

/** The message-shaped subset of the document's `AgentInput` this contract accepts: exactly
 *  what one `Message.content` can hold (`string | ReadonlyArray<MultiModalContent>`, matching
 *  `packages/conversationalist/src/types.ts:140`), narrowed to {@link UserAdmissibleContent} per
 *  AB-42's coordinator amendments (2026-09-02). The `{ conversation }` variant of `AgentInput`
 *  is out of scope for session-input admission; a caller with a full conversation to inject uses
 *  Bureau's conversation-replacement surface. AB-70 owns any future widening of the admissible
 *  content within this message-shaped constraint. */
export type SessionInputPayload = string | ReadonlyArray<UserAdmissibleContent>;

/** Per AB-42's coordinator amendments (2026-09-02): `TPayload` is bounded by
 *  {@link SessionInputPayload} so an explicit type argument can narrow the payload (e.g. to
 *  `string`, or to a single {@link UserAdmissibleContent} member) but never widen it past the
 *  user-admissible union. */
export interface SessionInputRecord<TPayload extends SessionInputPayload = SessionInputPayload> {
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
 *  'principal'>`; a body-supplied `principal` is never trusted. Per AB-42's coordinator
 *  amendments (2026-09-02), `TPayload` is bounded by {@link SessionInputPayload}, matching
 *  {@link SessionInputRecord}. */
export interface SessionInputAdmissionRequest<
  TPayload extends SessionInputPayload = SessionInputPayload,
> {
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
  /** `'id-owned-by-other-principal'` is per AB-42's coordinator amendments (2026-09-02): a
   *  session-input `id` is unique within its `sessionId` regardless of principal. A different
   *  `principal` submitting an `id` that already exists in the session gets this reason, and the
   *  existing record is untouched; the idempotency key stays `(principal, 'session-input', id)`
   *  for replay detection by the same principal. */
  readonly reason:
    | 'session-mismatch'
    | 'delivery-mode-mismatch'
    | 'payload-mismatch'
    | 'id-owned-by-other-principal';
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

// AB-67 — the runtime steering contract (decision record, ratified
// 2026-09-01). Type-only export; no runtime behavior attached. See
// `documentation/operative-type-safe-api.md`'s "## Steering commands"
// section for the full contract these types are drawn from verbatim.

/**
 * The seven configuration-facing operations `SteeringCommand` covers. Agent,
 * provider, model, route, and effort changes apply no earlier than the entry
 * of the next `runStep` call; agent-identity applies at step 0 of the
 * session's next `bureau.run` call; pause and resume gate that same
 * `runStep` entry. See AB-67's decision record, "Decisions by acceptance
 * criterion", for the per-operation authority, validation boundary,
 * application boundary, acknowledgement, rejection, supersession, and
 * terminal-behavior table.
 */
export type SteeringTargetKind =
  'agent-identity' | 'route' | 'model' | 'provider' | 'effort' | 'pause' | 'resume';

/**
 * Discriminated by `target`. `pause`/`resume` carry no value: the target
 * itself is the instruction. Every other target carries exactly one of
 * `policyRef` (a named, pre-approved policy the AB-66 selector resolves) or
 * `override` (an exact value), encoded as an exclusive pair — `policyRef?:
 * never` on the `override` arm and `override?: never` on the `policyRef`
 * arm — rather than two same-discriminant variants, so a literal supplying
 * both fields, or neither, is rejected by the type checker at compile time (AB-67's
 * 2026-09-02 coordinator amendments). The runtime admission check that
 * exactly one is present stays as defense in depth.
 */
export type SteeringRequestedValue =
  | { readonly target: 'pause' }
  | { readonly target: 'resume' }
  | { readonly target: 'agent-identity'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'agent-identity'; readonly override: string; readonly policyRef?: never } // a catalog agent name; must be a key of Bureau<D>'s agents map
  | { readonly target: 'route'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'route'; readonly override: string; readonly policyRef?: never } // must name a configured RoutingOptions.routes entry
  | { readonly target: 'model'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'model'; readonly override: string; readonly policyRef?: never }
  | { readonly target: 'provider'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'provider'; readonly override: string; readonly policyRef?: never }
  | { readonly target: 'effort'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'effort'; readonly override: Effort; readonly policyRef?: never }; // packages/operative/src/providers/types.ts

/**
 * A versioned steering command: a caller's request to change one of
 * agent-identity, route, model, provider, effort, pause, or resume, admitted
 * against a Bureau session. Parent-owned and addressable on its owning
 * session, matching AB-42's classification of session input.
 */
export interface SteeringCommand {
  readonly id: string;
  readonly idOrigin: 'caller' | 'generated'; // same idempotency shape as AB-42's SessionInputRecord
  readonly sessionId: string; // steering is a Bureau session verb (AB-39's ratified placement), never on AgentRun
  readonly principal: string;
  readonly requestedValue: SteeringRequestedValue;
  /** Optimistic concurrency against the session's own `configVersion` (see
   *  `SteeringDesiredState` below). Absent means "apply regardless of
   *  current desired state"; present means "reject as a conflict if
   *  configVersion has moved past this value." */
  readonly expectedRevision?: number;
  readonly requestedAt: string; // ISO
  readonly deadline?: string; // ISO, same semantics as AB-42's SessionInputRecord.expiresAt
  /** `pause`/`resume` only (AB-67's 2026-09-02 coordinator amendments). When
   *  present, must name a non-terminal run owned by `sessionId`, or
   *  admission fails with `SteeringCommandFailure.reason: 'run-terminal'`.
   *  When absent and the session has exactly one non-terminal run, the
   *  command binds to that run and the effective `runId` is recorded on the
   *  accepted command; when absent and the session has zero or more than
   *  one non-terminal run, admission fails with `'run-ambiguous'`.
   *  Configuration-targeting commands (`model`, `provider`, `route`,
   *  `effort`, `agent-identity`) remain session-scoped desired state and
   *  ignore `runId`. */
  readonly runId?: string;
}

/**
 * Populated on every terminal-failure `SteeringCommandState` (`rejected`,
 * `superseded`, `failed`), mirroring AB-42's `SessionInputFailure`.
 */
export interface SteeringCommandFailure {
  readonly failedAt: string; // ISO
  readonly reason:
    | 'session-terminal' // the owning session itself went terminal (closed) before application
    | 'run-terminal' // pause/resume only: the run it targeted ended (aborted or completed) before its gate could apply
    | 'run-ambiguous' // pause/resume only: no runId given and the session has zero or more than one non-terminal run (AB-67's 2026-09-02 coordinator amendments)
    | 'authorization-revoked'
    | 'policy-denied'
    | 'deadline-passed'
    | 'superseded-by'; // pairs with a successor command's id, same target
  /** The `id` of the successor `SteeringCommand`, present exactly when
   *  `reason` is `'superseded-by'` and absent otherwise (AB-67's 2026-09-02
   *  coordinator amendments). */
  readonly supersededBy?: string;
}

/**
 * `SteeringCommand`'s state machine. `requested` is never persisted on its
 * own: admission is synchronous validate-then-accept-or-reject, so it exists
 * only as the pre-admission moment, satisfied by the transition into
 * `accepted` or a pre-admission rejection outcome.
 */
export type SteeringCommandState =
  | 'requested' // received, not yet validated; exists only as the pre-admission moment, never persisted on its own
  | 'accepted' // validated, written into desired state, waiting for the next boundary
  | 'applied' // terminal-success: consumed at a step boundary, effective state stamped
  | 'rejected' // terminal-failure: invalidated post-admission (authorization revoked, policy denial)
  | 'superseded' // terminal-failure: a later command for the same target was admitted first
  | 'failed'; // terminal-failure: SteeringCommandFailure.reason is 'session-terminal' or, pause/resume only, 'run-terminal'

/**
 * The desired configuration a `SteeringCommand`, once `accepted`, writes
 * into. `configVersion` increments by exactly one on every command that
 * reaches `accepted`, whether or not it has been applied yet; it never
 * decrements and never skips, and is the value `SteeringCommand.expectedRevision`
 * checks optimistic concurrency against.
 */
export interface SteeringDesiredState {
  readonly agentName?: string;
  readonly route?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: Effort;
  readonly paused: boolean;
  readonly configVersion: number;
}

/**
 * What the step boundary reads out of `SteeringDesiredState` and stamps onto
 * a step. A separate type from `SteeringDesiredState`, not one type with an
 * "is this applied yet" flag, because a caller inspecting desired state
 * mid-flight must not be told a stale `appliedAtStep`.
 */
export interface SteeringEffectiveState extends SteeringDesiredState {
  /** The step index (`loop.ts`'s `step`) whose boundary last consumed this
   *  state; identical numbering to AB-42's SessionInputPromotion.providerTurn. */
  readonly appliedAtStep: number;
  readonly appliedAtRunId: string;
  readonly appliedAt: string; // ISO
}
