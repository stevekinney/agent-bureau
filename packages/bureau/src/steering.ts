import type { SteeringGate } from '@lostgradient/operative';
import type {
  SteeringCommand,
  SteeringCommandFailure,
  SteeringCommandState,
  SteeringRequestedValue,
} from '@lostgradient/operative/durable';
import { createDefaultRuntimeServices, type RuntimeClock } from 'lifecycle';

/**
 * AB-199 — the caller-facing admission request for {@link Bureau.submitSteeringCommand}.
 *
 * AB-67's own decision record (via its own out-of-scope note) leaves this
 * type unowned: it names only the seven-field `SteeringCommand` shape a
 * validated, admitted command carries, not the request a caller sends before
 * validation. The issue that ships `submitSteeringCommand` describes this
 * request as `Omit<SteeringCommand, 'idOrigin'> & { id?: string }`, but that
 * formula does not actually relax `id` to optional — TypeScript intersects a
 * required `id: string` (from the `Omit`) with an optional `id?: string`
 * (the added member) and keeps the narrower, required type. This interface
 * instead mirrors AB-42's `SessionInputAdmissionRequest` directly: `id` is
 * genuinely optional (server-generated when absent, exactly like
 * `SessionInputAdmissionRequest.id`), `sessionId` is omitted (it is the
 * method's own first parameter, not part of the request body — same as
 * `submitSessionInput`), and `requestedAt` is omitted (server-assigned at
 * admission, mirroring `SessionInputRecord.admittedAt`).
 */
export interface SteeringCommandRequest {
  readonly id?: string;
  readonly principal: string;
  readonly requestedValue: SteeringRequestedValue;
  /** Optimistic concurrency against the session's own `configVersion`
   *  (`SteeringDesiredState.configVersion`): present means "reject if
   *  configVersion has moved past this value" (`SteeringCommand.expectedRevision`'s
   *  own doc comment). Enforced in {@link BureauSteeringGate.admit} by
   *  rejecting a mismatch outright — `{ outcome: 'rejected', failure: {
   *  reason: 'policy-denied' } }`. `'policy-denied'` is a reuse of an
   *  existing ratified `SteeringCommandFailure` reason, not a perfect
   *  semantic fit (AB-67's decision record fixes no reason specifically for
   *  "stale expected revision") — chosen over fabricating a new,
   *  unratified reason string. */
  readonly expectedRevision?: number;
  /** ISO deadline. A command admitted after its own deadline has passed is
   *  rejected with `SteeringCommandFailure.reason: 'deadline-passed'` — the
   *  one reason AB-67's decision record already fixes for exactly this
   *  case, mirroring AB-42's `SessionInputRecord.expiresAt`. Also enforced a
   *  second time, past admission, at each application boundary (see
   *  {@link BureauSteeringGate.recordApplied}'s doc comment) — a command
   *  accepted just before its deadline must not silently apply after it. */
  readonly deadline?: string; // ISO
  /** `pause`/`resume` only — see `SteeringCommand.runId`'s doc comment. */
  readonly runId?: string;
}

/**
 * A point-in-time read of one admitted {@link SteeringCommand}'s outcome —
 * this issue's local analogue of AB-42's `SessionInputReceipt`, which AB-197
 * deliberately did not export at the operative layer (see AB-197's own "What
 * this issue deliberately does not export" section).
 */
export interface SteeringCommandSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly requestedValue: SteeringRequestedValue;
  readonly runId?: string;
  readonly requestedAt: string;
  readonly state: SteeringCommandState;
  readonly configVersion: number;
  readonly failure?: SteeringCommandFailure;
}

/**
 * Generalizes AB-42's `SessionInputConflict` pattern to steering's own three
 * reasons (AB-199's description, "The request type this issue defines"):
 * a same-`(principal, id)` retry whose `sessionId`, `target`, or
 * `requestedValue` disagrees with the original command is a typed conflict,
 * never a silent overwrite or a second `accepted` transition. The
 * idempotency key `(principal, id)` is scoped BUREAU-WIDE, not per session
 * (`createSteeringGate`'s shared `ledger` parameter) — mirroring AB-42's
 * `(principal, 'session-input', id)` scope exactly — so `session-mismatch`
 * is reachable: retrying the same key against a different, also-authorized
 * session is a conflict, not a second command admitted into that other
 * session's desired state. `requested-value-mismatch` is unreachable for
 * `pause`/`resume` through the public verb (neither carries a value to
 * disagree on) — it exists for a same-target, different-`policyRef`/`override`
 * reuse of one of the other five targets, reachable only through direct
 * {@link BureauSteeringGate.admit} calls today (see
 * {@link ImplementedSteeringCommand}'s doc comment).
 */
export interface SteeringCommandConflict {
  readonly id: string;
  readonly reason: 'session-mismatch' | 'target-mismatch' | 'requested-value-mismatch';
  readonly original: SteeringCommandSnapshot;
}

/**
 * `submitSteeringCommand`'s outcome union, mirroring AB-42's
 * `SessionInputAdmissionOutcome` shape:
 *
 * - `accepted` — a genuinely new, distinct `(principal, id)` command was
 *   admitted (which may still be a no-op against the gate's own desired
 *   state — see the Pause/Resume idempotency rule in AB-67's decision
 *   record — but is not a *replay* of a previously seen id).
 * - `replayed` — an exact retry of the same `(principal, id)` with an
 *   identical `requestedValue` returns the original command's current
 *   state unchanged.
 * - `conflict` — a same-`id` reuse under a mismatched `sessionId`, `target`,
 *   or `requestedValue`.
 * - `rejected` — a validated-but-invalid request: a specific `runId` not
 *   bound to the session's current non-terminal run
 *   (`SteeringCommandFailure.reason: 'run-terminal'`, per
 *   `SteeringCommand.runId`'s own doc comment), a `deadline` already passed
 *   (`reason: 'deadline-passed'`), or a stale `expectedRevision` (`reason:
 *   'policy-denied'`, see {@link SteeringCommandRequest.expectedRevision}).
 *   Distinct from `conflict` (no idempotency-key collision) and from
 *   `unsupported-capability` (the request is well-formed, just invalid on
 *   its own terms).
 * - `not-found` / `session-terminal` — AB-42's pre-admission outcomes,
 *   reused verbatim.
 * - `unsupported-capability` — every target other than `pause`/`resume`
 *   (`reason: 'selector-unavailable'`, matching the reason AB-67's decision
 *   record fixes for the four configuration targets, reused here for
 *   agent-identity too since its own real admission — catalog validation,
 *   policy resolution — is equally out of this issue's scope, per this
 *   issue's own "Out of scope" section), and `pause`/`resume` against a
 *   session with `runtime.durable` configured (`reason:
 *   'durable-steering-unavailable'`).
 */
export type SteeringCommandAdmissionOutcome =
  | { readonly outcome: 'accepted'; readonly command: SteeringCommandSnapshot }
  | { readonly outcome: 'replayed'; readonly command: SteeringCommandSnapshot }
  | { readonly outcome: 'conflict'; readonly conflict: SteeringCommandConflict }
  | { readonly outcome: 'rejected'; readonly failure: SteeringCommandFailure }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'session-terminal'; readonly sessionId: string }
  | { readonly outcome: 'unsupported-capability'; readonly reason: string };

/**
 * The subset of {@link SteeringCommand}'s seven targets this issue's gate
 * implementation actually admits. `pause`/`resume` are the two
 * `submitSteeringCommand` itself ever routes into {@link BureauSteeringGate.admit}
 * (every other target is rejected as `unsupported-capability` before the
 * gate is ever consulted — see `SteeringCommandAdmissionOutcome`'s doc
 * comment). `agent-identity` is admitted here too, but ONLY reachable
 * through direct calls to `admit` (this module's own tests, and whatever
 * `ab-67-bureau-b` calls once it resolves a `policyRef`/`override` before
 * calling in) — never through `submitSteeringCommand`, per AB-199's
 * coordinator amendments (2026-09-02, AB-221 review addendum): "only the
 * real `SteeringGate` can own" tracking which `configVersion` bump is
 * effective for the CURRENT run versus deferred to the next run's step 0,
 * because `SteeringDesiredState` is an aggregate with no per-target
 * application history of its own (see `run-step.ts`'s
 * `maybeDispatchSteeringApplied` comment). Building that tracking now, in
 * the one real implementation of `SteeringGate` this batch ships, is this
 * issue's contribution to that ruling — `ab-67-bureau-b` (AB-200) still
 * owns admitting an agent-identity command through the public verb
 * (catalog validation, policyRef resolution), and route/model/provider/
 * effort are untouched here entirely (see AB-200's own scope).
 *
 * Narrowing the parameter type this way, rather than a runtime `switch`
 * with a `default: throw`, means there is no unreachable-but-uncovered
 * branch for route/model/provider/effort: the type system, not a runtime
 * guard, is what keeps them out of this method.
 */
export type ImplementedSteeringCommand = SteeringCommand & {
  readonly requestedValue: Extract<
    SteeringRequestedValue,
    { target: 'pause' | 'resume' | 'agent-identity' }
  >;
};

/**
 * Context {@link BureauSteeringGate.admit} needs from its caller:
 *
 * - `liveRunIds` — every currently non-terminal run owned by this session,
 *   per `create-bureau.ts`'s own live run registry (`store.getState().runs`
 *   filtered to `status === 'running'` and this `sessionId`, via
 *   `getRunSessionIdentifier`) — genuine enumeration, not an inference from
 *   a single `metadata['lastRunId']` field (review finding, PR #430 — Codex
 *   P2: a single field "identifies only the most recently persisted writer,
 *   not the sole non-terminal run"). Implements AB-67's ratified binding
 *   rule directly: an explicit `SteeringCommand.runId` must be a member of
 *   this list or admission fails `'run-terminal'`; an absent `runId` binds
 *   to the list's sole member, or fails `'run-ambiguous'` when the list has
 *   zero or more than one entry.
 * - `now` — the current timestamp (injected, not read from the wall clock
 *   directly, so admission stays deterministically testable).
 */
export interface SteeringAdmissionContext {
  readonly liveRunIds: readonly string[];
  readonly now: string; // ISO
}

/**
 * Bureau's concrete `SteeringGate` (AB-67/AB-199): the per-session state
 * machine `submitSteeringCommand` and `runStep`'s boundary read both consult
 * — `submitSteeringCommand` calls {@link admit}/{@link failAcceptedForRun},
 * `runStep` calls the inherited `getDesiredState`/`awaitResume`/
 * `getAppliedFloor` (through {@link forRun}'s per-run view — see its doc
 * comment for why the RAW gate is never injected directly), and Bureau's own
 * run-lifecycle listeners call {@link recordApplied} (the write side of
 * cross-run dedupe — the operative boundary only reads `getAppliedFloor`,
 * see `types.ts`'s doc comment on that method) and {@link promoteForNewRun}
 * (identity-deferral promotion) at the two points named on each method.
 */
export interface BureauSteeringGate extends SteeringGate {
  /** Admit one validated `pause`/`resume`/`agent-identity` command. Called
   *  by `submitSteeringCommand` for `pause`/`resume` only; `agent-identity`
   *  is reachable only via a direct call (see
   *  {@link ImplementedSteeringCommand}'s doc comment). */
  admit(
    command: ImplementedSteeringCommand,
    context: SteeringAdmissionContext,
  ): SteeringCommandAdmissionOutcome;
  /** Narrows {@link SteeringGate.getAppliedFloor} from optional to required:
   *  this concrete implementation always defines it (unlike a hypothetical
   *  third-party `SteeringGate` that predates AB-199's cross-run dedupe
   *  addition and has no cross-run memory of its own). */
  getAppliedFloor(): number;
  /**
   * A per-run VIEW of this session's gate, scoped to `runId`: its
   * `getDesiredState().paused` and `awaitResume()` reflect only a pause
   * bound to THIS run, never a pause a concurrent run on the same session
   * separately admitted (review finding, PR #430 — Codex P1: "two in-memory
   * runs sharing one gate meant a pause admitted for run B also blocked run
   * A"). `getDesiredState().configVersion` is likewise scoped to this run —
   * this run's own baseline at start (see {@link promoteForNewRun}) plus any
   * pause/resume bound to this run specifically — NEVER a configVersion
   * bump caused by a pause/resume bound to a DIFFERENT concurrent run
   * (review finding, PR #430 — Codex P2, "Scope applied config versions to
   * the target run": the earlier per-run pause-ISOLATION fix left this
   * per-run VERSION still session-wide, so a pause bound to run A still
   * inflated run B's own reported `configVersion`, which in turn caused
   * `recordApplied` to misapply run A's still-unconsumed pause command).
   * `agentName` reflects only the identity `promoteForNewRun(runId, ...)`
   * ACTUALLY CAPTURED for THIS run at ITS OWN promotion — never the live,
   * session-wide `agentName` a LATER promotion for a different, concurrent
   * run may since have changed (review finding, PR #430 — Codex P2, "Scope
   * promoted agent identities to runs started afterward": run A already
   * active, an identity command admitted, then concurrent run B starts and
   * promotes it — A's own view must keep reporting whatever was effective
   * when A itself started, never B's newly-promoted name). Never a
   * `pendingAgentName` deferred to a future run either (see
   * `promoteForNewRun`'s doc comment). `getAppliedFloor()` is session-wide
   * (unaffected by which run reads it — it exists purely to seed a brand
   * new run's dedupe cursor) and passes through unchanged.
   * `createRunFromRequest` injects `gate.forRun(runId)` into
   * `RunOptions.steering` — never the raw gate itself — so this is the
   * ONLY way a real run ever observes desired state.
   */
  forRun(runId: string): SteeringGate;
  /**
   * The write side of cross-run dedupe (`getAppliedFloor` is the read
   * side): called whenever `runId`'s own run emits `SteeringAppliedEvent` at
   * a step boundary, raising the (session-wide) applied floor and promoting
   * ledger entries `runId` is actually responsible for consuming to
   * `applied`:
   *
   * - A `pause`/`resume` command bound to `runId` itself, at or below
   *   `configVersion` — pause/resume are immediately effective within the
   *   SAME run they are admitted in, so this is a simple `<=` comparison
   *   against the version this boundary read observed.
   * - An `agent-identity` command (session-scoped, no `runId` of its own),
   *   but ONLY when its `configVersion` is at or below `runId`'s OWN
   *   BASELINE (the `configVersion` snapshot `promoteForNewRun` captured at
   *   `runId`'s start) — never merely at or below the `configVersion` this
   *   boundary happens to report right now. The distinction matters because
   *   a pause admitted mid-run bumps `configVersion` past a LATER,
   *   still-`accepted` identity command deferred to the session's NEXT run;
   *   comparing against the reported `configVersion` directly would
   *   misapply that deferred identity change to the wrong (current) run
   *   (review finding, PR #430 — Codex P2, "Keep deferred identity changes
   *   out of pause application").
   *
   * Also enforces {@link SteeringCommandRequest.deadline} a second time,
   * past admission, for `agent-identity` and `pause` (review finding, PR
   * #430 — Codex P2, "Expire accepted commands before their application
   * boundary"):
   *
   * - `agent-identity`'s effect is genuinely deferred until this exact
   *   moment, so a deadline that passed in the interim must prevent it from
   *   ever taking effect: `failed`/`'deadline-passed'` instead of `applied`,
   *   nothing to revert (it was never applied).
   * - `pause`'s effect already committed synchronously at ADMISSION (see
   *   {@link admit}), but an expired pause must actually STOP pausing, not
   *   merely record `failed` while `pausedRunIds` stays untouched (review
   *   finding, PR #430 — Codex P1, "Revert expired commands' desired-state
   *   changes": an unreverted expiry left `runStep` blocked forever with a
   *   contradictory `failed` ledger record). So an expired pause both
   *   transitions to `failed`/`'deadline-passed'` AND releases the run —
   *   `pausedRunIds.delete`/`releaseWaitersFor`/the aggregate-waiter release
   *   below, the identical release `failAcceptedForRun` performs on run
   *   termination.
   * - `resume` is deliberately excluded: its "effect" already happened at
   *   ADMISSION (the run was released then) and there is nothing to revert
   *   — a resume cannot retroactively "un-release" a run. Its own
   *   admission-time deadline check (see {@link admit}) is the only one that
   *   applies to it.
   */
  recordApplied(runId: string, configVersion: number, now: string): void;
  /**
   * Called by `submitSteeringCommand`'s caller — `createRunFromRequest` —
   * the moment a NEW run starts (never on a durable resume of an existing
   * run, which has no gate at all per AB-199's in-memory-only scope):
   * promotes any agent-identity bump deferred by a prior run into this
   * session's effective desired state, clears the now-promoted (or
   * otherwise no-longer-pending) identity command from supersession
   * eligibility, catches the raw (session-wide) `effectiveConfigVersion` up
   * to the raw counter (a no-op when nothing was pending), and captures
   * `runId`'s OWN baseline `configVersion` — the value {@link forRun}'s
   * per-run view and {@link recordApplied}'s identity-eligibility check both
   * read — as the highest `configVersion` any agent-identity command has
   * reached AT THIS MOMENT (never the raw counter directly, which also
   * advances on every pause/resume across every run on the session — see
   * `lastIdentityVersion`'s own doc comment in `createSteeringGate`). Every
   * agent-identity `configVersion` admitted before this call is already part
   * of `runId`'s starting state; every one admitted after is deferred to a
   * FUTURE run's own baseline.
   *
   * Rejects (rather than promotes) a still-`accepted` pending agent-identity
   * command whose `deadline` already passed by `now` — its effect is
   * genuinely deferred until this exact moment, so an expired deadline must
   * prevent it from EVER taking effect, the identical application-time
   * deadline enforcement {@link recordApplied} performs for a command whose
   * effect is not deferred (review finding, PR #430 — Codex P2, "Reject
   * expired identities before promoting them"). `now` defaults to the
   * current wall-clock time when omitted (every existing caller that never
   * sets a deadline is unaffected either way).
   *
   * Also captures the just-promoted (or already-effective) `agentName` —
   * never `undefined` when one exists — into a PER-RUN record `forRun`
   * reads from, so a LATER promotion for a different, concurrent run never
   * retroactively changes what an ALREADY-RUNNING run's own `forRun` view
   * reports (review finding, PR #430 — Codex P2, "Scope promoted agent
   * identities to runs started afterward").
   */
  promoteForNewRun(runId: string, now?: string): void;
  /** Called by the run's own `run.completed`/`run.aborted` listeners:
   *  transitions every still-`accepted` `pause`/`resume` command bound to
   *  `runId` to `failed`/`'run-terminal'` (AB-67's ratified Abort row: a
   *  pause/resume never carries into a future run), and — regardless of
   *  whether the owning command already reached `applied` before this call
   *  (review finding, PR #430 — Codex P1: `recordApplied` can promote a
   *  paused command to `applied` before the run's own terminal listener
   *  fires, which an `state === 'accepted'`-only predicate would then skip,
   *  leaving `paused` stuck for every future run on the session) —
   *  unconditionally releases the pause binding and any `awaitResume()`
   *  waiter FOR THIS RUN. Defense in depth alongside `run-step.ts`'s own
   *  abort race, which already resolves a paused step's wait the moment the
   *  step's `AbortSignal` fires. */
  failAcceptedForRun(runId: string, now: string): void;
  /**
   * Removes every ledger entry this session owns (across every principal),
   * called by `deleteSession` immediately AFTER the persistent deletion
   * succeeds (review finding, PR #430 — Codex P2, "Purge deleted sessions
   * from the shared ledger": entries left behind let a `(principal, id)`
   * retry against a session id that gets REUSED after deletion replay
   * against the deleted session's stale record instead of admitting a
   * genuinely new command into the new session's fresh gate).
   */
  purgeFromLedger(): void;
  /**
   * Releases every run this gate still has bookkeeping for — paused or not
   * — the moment `deleteSession` decides to discard this gate entirely:
   * every still-`accepted` `pause`/`resume` command bound to one of those
   * runs transitions to `failed`/`'run-terminal'`, `pausedRunIds` is
   * cleared for each, and every `awaitResume()` waiter (the run's own
   * `runStep`, genuinely blocked on this gate) is released. Without this, a
   * PAUSED run's steering channel simply vanishes with the gate: every
   * later `submitSteeringCommand` against the (now-deleted) session already
   * returns `not-found`, so nothing could ever resume it again, and its
   * `runStep` would await a promise this gate's own closure held forever
   * (review finding, PR #430 — Codex P2, "Settle paused runs before
   * deleting their steering gate"). Called by `deleteSession` AFTER the
   * underlying persistent deletion succeeds (the same ordering
   * {@link purgeFromLedger}'s own doc comment already fixes for this gate)
   * and BEFORE that same `purgeFromLedger` call.
   */
  settleForDeletion(now: string): void;
}

/**
 * The bureau-wide idempotency ledger every session's `SteeringGate` shares
 * — see {@link createSteeringGate}'s `ledger` parameter doc comment. Keyed
 * by `principal`, then `id` — a nested `Map`, not a single `Map` keyed by a
 * delimited string like `` `${principal}:${id}` ``, because concatenation
 * makes the key ambiguous: `('a:b', 'c')` and `('a', 'b:c')` both produce
 * `'a:b:c'` (review finding, PR #430 — Codex P2, "Use an unambiguous
 * idempotency key"). Nesting keeps the two components genuinely distinct
 * with no encoding to get wrong.
 */
export type SteeringCommandLedger = Map<string, Map<string, StoredSteeringCommand>>;

/** Constructs an empty {@link SteeringCommandLedger}. `create-bureau.ts`
 *  calls this exactly once and passes the result to every
 *  `createSteeringGate` call for that bureau instance. */
export function createSteeringCommandLedger(): SteeringCommandLedger {
  return new Map();
}

interface StoredSteeringCommand {
  readonly id: string;
  readonly sessionId: string;
  readonly principal: string;
  readonly requestedValue: SteeringRequestedValue;
  /** The RESOLVED bound run — for `pause`/`resume`, the run admission
   *  actually gated (which may differ from `requestedRunId` when the
   *  original request omitted `runId` and it was resolved from the
   *  session's sole live run); `undefined` for `agent-identity` (session-
   *  scoped, no run binding). Read by {@link recordApplied} and
   *  {@link BureauSteeringGate.failAcceptedForRun}. */
  readonly runId: string | undefined;
  /** The RAW `SteeringCommand.runId` field as the caller sent it (including
   *  `undefined` when omitted) — distinct from `runId` above. Compared
   *  against a same-`(principal, id)` retry's own raw `runId` in `admit()`'s
   *  idempotency check, so a retry naming a DIFFERENT run than the original
   *  request is a typed conflict rather than a false `replayed` (review
   *  finding, PR #430 — Codex P2, "Include the bound run in replay
   *  matching"): comparing only `sessionId`/`target`/`requestedValue` missed
   *  that `runId` determines which run a pause/resume actually affects. */
  readonly requestedRunId: string | undefined;
  readonly requestedAt: string;
  readonly deadline: string | undefined;
  configVersion: number;
  state: SteeringCommandState;
  failure: SteeringCommandFailure | undefined;
}

function snapshotOf(stored: StoredSteeringCommand): SteeringCommandSnapshot {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    principal: stored.principal,
    // Copied, not the ledger's own live object: a caller mutating the
    // returned snapshot's `requestedValue` must never rewrite the stored
    // idempotency record itself (review finding, PR #430 — Codex P2,
    // "Detach command snapshots from the mutable ledger").
    requestedValue: { ...stored.requestedValue },
    ...(stored.runId !== undefined ? { runId: stored.runId } : {}),
    requestedAt: stored.requestedAt,
    state: stored.state,
    configVersion: stored.configVersion,
    // Also copied, not the ledger's own live object — the same rationale as
    // `requestedValue` above applies one level deeper: a caller mutating a
    // failed/superseded snapshot's own nested `failure` object (`reason`,
    // `failedAt`, `supersededBy`) must never rewrite the stored command's
    // failure record itself (review finding, PR #430 — Codex P2, "Copy
    // failures when returning command snapshots").
    ...(stored.failure !== undefined ? { failure: { ...stored.failure } } : {}),
  };
}

/** Structural equality for `SteeringRequestedValue`, field by field —
 *  `target`, then whichever of `policyRef`/`override` is present — rather
 *  than a `JSON.stringify` comparison, which is sensitive to KEY ORDER: two
 *  semantically identical requests built with their fields in a different
 *  order (`{ target, override }` vs. `{ override, target }`) would
 *  otherwise compare unequal and misreport an idempotent retry as a
 *  `requested-value-mismatch` conflict (review finding, PR #430 — Codex P2,
 *  "Compare steering values independently of property order"). Every
 *  variant is a small, flat object of primitive fields with no nested
 *  objects, so comparing `target`/`policyRef`/`override` directly is a
 *  complete equality check. */
function sameRequestedValue(a: SteeringRequestedValue, b: SteeringRequestedValue): boolean {
  if (a.target !== b.target) return false;
  const policyRefA = 'policyRef' in a ? a.policyRef : undefined;
  const policyRefB = 'policyRef' in b ? b.policyRef : undefined;
  const overrideA = 'override' in a ? a.override : undefined;
  const overrideB = 'override' in b ? b.override : undefined;
  return policyRefA === policyRefB && overrideA === overrideB;
}

/**
 * Registers `signal`-bound cleanup for one pause waiter, closing two leaks a
 * review found (PR #430 — Copilot):
 *
 * - An ALREADY-aborted `signal` never fires its `'abort'` event for a
 *   listener added after the fact (standard `AbortSignal` semantics), so a
 *   caller passing one in would otherwise register a waiter this function's
 *   caller can never remove — a permanent leak. Checked up front; nothing is
 *   registered at all in that case (the caller's own abort race, external to
 *   this gate, already treats the run as aborted).
 * - A NORMAL resume (the waiter resolves through `resolve`, not through
 *   abort) previously left the `'abort'` listener registered on `signal`
 *   forever, since `signal` is the run's own long-lived `AbortSignal`,
 *   reused across every pause/resume cycle in that run. Repeated cycles
 *   accumulated one stale listener per pause. `resolve` now removes its own
 *   abort listener before resolving.
 */
function registerPauseWaiter(
  waiters: Array<() => void>,
  resolve: () => void,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) return;
  const onAbort = (): void => {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
  };
  const waiter = (): void => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  };
  waiters.push(waiter);
  signal?.addEventListener('abort', onAbort, { once: true });
}

/**
 * Creates one session's `SteeringGate`. One instance per `sessionId`,
 * created EAGERLY by `createRunFromRequest` at the start of every in-memory
 * run (not lazily on the first `submitSteeringCommand` call — a
 * lazily-created gate would miss every run already in flight; see the
 * identical note in `create-bureau.ts`) and held for the bureau's lifetime,
 * matching how `create-bureau.ts` already holds other per-session maps
 * (e.g. `pendingApprovalOverrides`) — except this one IS cleaned up, on
 * `deleteSession` (see `create-bureau.ts`'s `deleteSession`), since an old
 * gate's pause state / command ledger / applied floor must not leak into a
 * session id that gets reused after deletion (review finding, PR #430 —
 * Codex P2). `deleteSession` deletes the gate itself only AFTER the
 * underlying persistent deletion succeeds — and only then also purges this
 * session's entries from the shared ledger via {@link BureauSteeringGate.purgeFromLedger}
 * — so a deletion that fails leaves both the gate and its ledger entries
 * intact for the still-live session (review finding, PR #430 — Codex P2,
 * "Keep the gate until session deletion succeeds").
 *
 * `ledger` is the bureau-wide `(principal, id)` idempotency map (AB-42's
 * `(principal, 'session-input', id)` scope, generalized) — shared across
 * EVERY session's gate, not private to this one, so a same-`(principal, id)`
 * retry against a DIFFERENT session correctly resolves to `session-mismatch`
 * instead of being silently admitted as an unrelated command in that other
 * session (review finding, PR #430 — Codex P2). Defaults to a private `Map`
 * for direct unit-testing of one gate in isolation (this module's own
 * tests); `create-bureau.ts` constructs exactly one shared instance and
 * passes it to every `createSteeringGate` call.
 */
export function createSteeringGate(
  sessionId: string,
  ledger: SteeringCommandLedger = new Map(),
  // AB-260: the injected clock reads a promoted identity's expiry (`forRun`'s
  // `getDesiredState`) against the composed `RuntimeServices.clock` rather
  // than the real wall clock directly. Defaults to the real-globals runtime
  // so every pre-existing caller (including this package's own extensive
  // test suite, which constructs a gate with no third argument) is
  // unaffected — this is not part of AB-260's retired
  // `RuntimeCompositionTestingSeams` grouping, just the same
  // real-globals-default injection pattern `RuntimeServices` establishes
  // everywhere else.
  clock: RuntimeClock = createDefaultRuntimeServices().clock,
): BureauSteeringGate {
  let rawConfigVersion = 0;
  let effectiveConfigVersion = 0;
  let appliedFloor = 0;
  let agentName: string | undefined;
  let pendingAgentName: string | undefined;
  // The ledger key of the currently-pending, not-yet-terminal agent-identity
  // command (if any) — used to transition it to `superseded`/`superseded-by`
  // the moment a REPLACEMENT agent-identity command is admitted before the
  // first one ever applied (review finding, PR #430 — Codex P2, "Supersede
  // earlier pending identity commands").
  let pendingIdentityKey: { principal: string; id: string } | undefined;
  // Keyed by runId (or the '(unbound)' sentinel for a pause admitted with no
  // resolvable boundRunId — reachable only from a direct `admit()` call with
  // no `boundRunId` in context, never from `submitSteeringCommand`, which
  // always resolves one from the session's `lastRunId` before calling in).
  const UNBOUND = '(unbound)';
  const pausedRunIds = new Set<string>();
  const waitersByRunId = new Map<string, Array<() => void>>();
  // Each run's own configVersion baseline — captured once, at `promoteForNewRun`
  // — and the highest configVersion any pause/resume BOUND TO THAT RUN has
  // reached. See `forRun`'s doc comment for why these must be kept distinct
  // per run rather than reading the single session-wide `effectiveConfigVersion`.
  const runBaseline = new Map<string, number>();
  const runLastPauseVersion = new Map<string, number>();
  // The highest configVersion `recordApplied` has actually OBSERVED at a
  // boundary for this run — distinct from the session-wide `appliedFloor`,
  // which a DIFFERENT, concurrent run's own `recordApplied` call also
  // raises. `record()`'s own initial-state check for a NEW pause/resume
  // command reads THIS, not `appliedFloor`: a second pause admitted for run
  // A must never be recorded `applied` at admission time merely because
  // some unrelated run B's boundary happened to advance the session-wide
  // floor past A's own (still genuinely un-observed) version (review
  // finding, PR #430 — Codex P2, "Avoid treating noncontiguous applied
  // versions as a floor").
  const runAppliedVersion = new Map<string, number>();
  // The (principal, id) of the pause/resume command that actually OWNS this
  // run's current pause-state transition — the one real state change,
  // distinct from any same-version idempotent no-op replay recorded
  // alongside it (see `record()`'s own doc comment on `alreadyAtTarget`).
  // Two roles:
  //  - `admit()` supersedes the PREVIOUS owner the moment a NEW transition
  //    replaces it (review finding, PR #430 — Codex P2, "Do not mark
  //    skipped steering versions as applied": a pause the run's boundary
  //    never actually observed, because a resume overtook it first, must
  //    not later be misreported as `applied`).
  //  - `recordApplied`'s deadline-expiry branch only releases `pausedRunIds`
  //    when the EXPIRING command is one of this run's actual owners, and
  //    only once EVERY owner has expired — a duplicate idempotent replay
  //    (or a second, distinct pause admitted while already paused) sharing
  //    the transition's configVersion but carrying its OWN (possibly
  //    earlier or later) deadline must never revert a pause another,
  //    still-valid owner is holding open (review finding, PR #430 — Codex
  //    P2, "Do not release pauses owned by another command", and its
  //    converse, "Keep a valid duplicate pause when the owner expires": a
  //    single `{ principal, id }` owner cannot represent "the run stays
  //    paused as long as ANY of several distinct pause commands admitted
  //    for the same transition remain unexpired" — a per-run SET of owners
  //    can). A resume, or a fresh pause transition that supersedes the
  //    current one, clears every owner in the set at once (see
  //    `clearPauseOwners`) — resuming or re-pausing ends every outstanding
  //    pause command's hold on this run's state, not just one.
  const runPauseOwners = new Map<string, Map<string, { principal: string; id: string }>>();

  function pauseOwnerKey(principal: string, id: string): string {
    return `${principal} ${id}`;
  }

  /** Adds `command` as one of `runId`'s current pause owners — called both
   *  when a pause TRANSITIONS the run to paused (the first owner) and when
   *  a further, distinct pause command is admitted as an idempotent no-op
   *  while already paused (an additional owner holding the same pause
   *  open). */
  function addPauseOwner(runId: string, principal: string, id: string): void {
    let owners = runPauseOwners.get(runId);
    if (!owners) {
      owners = new Map();
      runPauseOwners.set(runId, owners);
    }
    owners.set(pauseOwnerKey(principal, id), { principal, id });
  }

  /** Marks every still-`accepted` current owner of `runId`'s pause
   *  `superseded`/`'superseded-by'` and clears the owner set — called on a
   *  resume (nothing left to own) and on a fresh pause transition (the
   *  prior owners' pause intent is replaced by this new one), mirroring
   *  the single-owner supersession `admit()` performed before this gate
   *  tracked more than one owner. */
  function clearPauseOwners(runId: string, now: string, supersededBy: string): void {
    const owners = runPauseOwners.get(runId);
    if (!owners) return;
    for (const { principal, id } of owners.values()) {
      const prior = ledgerGet(principal, id);
      if (prior && prior.state === 'accepted') {
        prior.state = 'superseded';
        prior.failure = { failedAt: now, reason: 'superseded-by', supersededBy };
      }
    }
    runPauseOwners.delete(runId);
  }
  // The agentName `promoteForNewRun(runId, ...)` actually captured FOR THAT
  // RUN — never the live, session-wide `agentName` below, which a LATER
  // promotion for a different, concurrent run can change out from under an
  // already-running one (see `forRun`'s own doc comment).
  const runAgentName = new Map<string, string>();
  // The `deadline` of whichever agent-identity command actually supplied
  // `runAgentName.get(runId)`, if it had one — `undefined` means either no
  // identity was captured for this run, or it was captured with no
  // deadline at all. Read by `forRun`'s `getDesiredState()` to recheck
  // validity at the moment the identity is actually EXPOSED to a step
  // (review finding, PR #430 — Codex P2, "Recheck identity deadlines
  // before exposing them to step zero"): an identity valid when
  // `promoteForNewRun()` ran can still expire in the (typically brief, but
  // real for a direct `SteeringGate` consumer) window before the new run's
  // step 0 actually reads `forRun(runId).getDesiredState()` — recordApplied
  // marking the underlying ledger command `failed` at that later boundary
  // does not, by itself, remove an already-captured `agentName` from this
  // per-run view, since the two are otherwise independent. Mirrors
  // `agentNameDeadline` below at the session-wide (not-yet-promoted-to-a-
  // run) level.
  const runAgentDeadline = new Map<string, string>();
  // The `deadline` of whichever agent-identity command most recently set
  // session-wide `agentName` (mirrors `agentName` itself) — captured
  // alongside it in `promoteForNewRun` from `pendingAgentDeadline` below,
  // and copied into `runAgentDeadline` the same moment `agentName` is
  // copied into `runAgentName`.
  let agentNameDeadline: string | undefined;
  // The `deadline` of the currently-pending `pendingAgentName`, mirroring
  // it exactly — set in `admit()`'s identity branch alongside
  // `pendingAgentName`, promoted into `agentNameDeadline` alongside it too.
  let pendingAgentDeadline: string | undefined;
  // The highest configVersion any agent-identity command has reached
  // (pending or already promoted) — the ONLY session-scoped target this gate
  // implements. `promoteForNewRun` seeds a new run's baseline from THIS, not
  // from `rawConfigVersion` directly: `rawConfigVersion` also advances on
  // every pause/resume across every run on the session, and seeding a new
  // run's baseline from it would leak an unrelated, possibly already-failed
  // run's own pause/resume version into the new run's reported
  // `configVersion` — spuriously firing `steering.applied` for a version
  // that means nothing to the new run at all (review finding, PR #430 —
  // Codex P2, "Exclude run-specific commands from new-run baselines").
  let lastIdentityVersion = 0;

  function waitersFor(runId: string): Array<() => void> {
    let waiters = waitersByRunId.get(runId);
    if (!waiters) {
      waiters = [];
      waitersByRunId.set(runId, waiters);
    }
    return waiters;
  }

  function releaseWaitersFor(runId: string): void {
    const waiters = waitersByRunId.get(runId);
    if (!waiters || waiters.length === 0) return;
    waitersByRunId.set(runId, []);
    for (const resolve of waiters) resolve();
  }

  /** Releases the raw gate's own aggregate `awaitResume()` waiters once NO
   *  run on this session is paused any more (review finding, PR #430 —
   *  Codex P2, "Release aggregate waiters after all runs resume"): a direct
   *  consumer of the raw gate (never the real Bureau run path, which always
   *  goes through `forRun`) would otherwise wait forever once the specific
   *  run(s) it was aggregated across all resume, since resuming a single
   *  run only ever releases that run's OWN bucket. */
  function releaseUnboundWaitersIfFullyResumed(): void {
    if (pausedRunIds.size === 0) releaseWaitersFor(UNBOUND);
  }

  function bump(): number {
    rawConfigVersion += 1;
    return rawConfigVersion;
  }

  function runVisibleVersion(runId: string): number {
    return Math.max(runBaseline.get(runId) ?? 0, runLastPauseVersion.get(runId) ?? 0);
  }

  function ledgerGet(principal: string, id: string): StoredSteeringCommand | undefined {
    return ledger.get(principal)?.get(id);
  }

  function ledgerSet(principal: string, id: string, stored: StoredSteeringCommand): void {
    let principalMap = ledger.get(principal);
    if (!principalMap) {
      principalMap = new Map();
      ledger.set(principal, principalMap);
    }
    principalMap.set(id, stored);
  }

  function record(
    command: ImplementedSteeringCommand,
    runId: string | undefined,
    configVersion: number,
    now: string,
  ): StoredSteeringCommand {
    const target = command.requestedValue.target;
    // Run-scoped (pause/resume) commands compare against THIS run's own
    // observed-applied version, never the session-wide `appliedFloor` — see
    // `runAppliedVersion`'s own doc comment. Session-scoped agent-identity
    // has no per-run version of its own, so it keeps comparing against the
    // session-wide floor (a run-agnostic maximum is the only floor that
    // makes sense for a target with no run to scope it to).
    const alreadyObservedAt =
      (target === 'pause' || target === 'resume') && runId !== undefined
        ? (runAppliedVersion.get(runId) ?? 0)
        : appliedFloor;
    const stored: StoredSteeringCommand = {
      id: command.id,
      sessionId: command.sessionId,
      principal: command.principal,
      // Copied, not the caller's own object — see `snapshotOf`'s identical
      // rationale (review finding, PR #430 — Codex P2, "Detach command
      // snapshots from the mutable ledger").
      requestedValue: { ...command.requestedValue },
      runId,
      requestedRunId: command.runId,
      requestedAt: now,
      deadline: command.deadline,
      configVersion,
      state: configVersion <= alreadyObservedAt ? 'applied' : 'accepted',
      failure: undefined,
    };
    ledgerSet(command.principal, command.id, stored);
    return stored;
  }

  const gate: BureauSteeringGate = {
    sessionId,

    getDesiredState() {
      return {
        // Aggregate view for the raw gate (no single run in scope): paused
        // if ANY run on this session is currently paused. Real runs never
        // read this directly — see `forRun`'s doc comment.
        paused: pausedRunIds.size > 0,
        configVersion: effectiveConfigVersion,
        ...(pendingAgentName !== undefined || agentName !== undefined
          ? { agentName: pendingAgentName ?? agentName }
          : {}),
      };
    },

    awaitResume(signal?: AbortSignal): Promise<void> {
      if (pausedRunIds.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        registerPauseWaiter(waitersFor(UNBOUND), resolve, signal);
      });
    },

    getAppliedFloor(): number {
      return appliedFloor;
    },

    forRun(runId: string): SteeringGate {
      return {
        sessionId,
        getDesiredState() {
          const promotedAgentName = runAgentName.get(runId);
          // Rechecked HERE, at the moment the identity is actually exposed
          // to a step, not only once at `promoteForNewRun` time — the
          // deadline the promoted command carried (if any) can pass in the
          // window between promotion and this read (review finding, PR
          // #430 — Codex P2, "Recheck identity deadlines before exposing
          // them to step zero"). An expired identity is treated exactly as
          // if it had never been captured — see `runAgentDeadline`'s own
          // doc comment.
          const deadline = runAgentDeadline.get(runId);
          const identityExpired = deadline !== undefined && clock.now() > Date.parse(deadline);
          return {
            paused: pausedRunIds.has(runId),
            // Scoped to THIS run: its own baseline plus any pause/resume
            // bound to it specifically — never a bump caused by a
            // concurrent, different run's own pause/resume (see this
            // interface's own `forRun` doc comment).
            configVersion: runVisibleVersion(runId),
            // The identity captured for THIS run at ITS OWN
            // `promoteForNewRun` call, never the live, session-wide
            // `agentName` — a LATER promotion for a different, concurrent
            // run must not retroactively change what this run reports (see
            // this interface's own `forRun` doc comment). Also never
            // `pendingAgentName` — a deferred identity change is not yet
            // effective for any run still in flight (see
            // `promoteForNewRun`'s doc comment).
            ...(promotedAgentName !== undefined && !identityExpired
              ? { agentName: promotedAgentName }
              : {}),
          };
        },
        awaitResume(signal?: AbortSignal): Promise<void> {
          if (!pausedRunIds.has(runId)) return Promise.resolve();
          return new Promise<void>((resolve) => {
            registerPauseWaiter(waitersFor(runId), resolve, signal);
          });
        },
        getAppliedFloor(): number {
          return appliedFloor;
        },
      };
    },

    admit(command, context) {
      const existing = ledgerGet(command.principal, command.id);
      if (existing) {
        if (existing.sessionId !== command.sessionId) {
          return {
            outcome: 'conflict',
            conflict: {
              id: command.id,
              reason: 'session-mismatch',
              original: snapshotOf(existing),
            },
          };
        }
        if (existing.requestedValue.target !== command.requestedValue.target) {
          return {
            outcome: 'conflict',
            conflict: { id: command.id, reason: 'target-mismatch', original: snapshotOf(existing) },
          };
        }
        // A pause/resume retry naming a DIFFERENT run than the original
        // request is a typed conflict, not a replay — runId determines
        // which run the command actually affects (review finding, PR #430
        // — Codex P2, "Include the bound run in replay matching"). Compares
        // the RAW requested runId (undefined when omitted), not the
        // resolved bound run — an omitted runId that resolves differently
        // across two admissions (the session's sole live run changed
        // between them) is a liveness/binding question `run-terminal`/
        // `run-ambiguous` already own, not an idempotency conflict.
        if (existing.requestedRunId !== command.runId) {
          return {
            outcome: 'conflict',
            conflict: {
              id: command.id,
              reason: 'requested-value-mismatch',
              original: snapshotOf(existing),
            },
          };
        }
        if (sameRequestedValue(existing.requestedValue, command.requestedValue)) {
          return { outcome: 'replayed', command: snapshotOf(existing) };
        }
        return {
          outcome: 'conflict',
          conflict: {
            id: command.id,
            reason: 'requested-value-mismatch',
            original: snapshotOf(existing),
          },
        };
      }

      // AB-67/AB-199 review finding (PR #430 — Codex P2, second wave,
      // "Reject commands addressed to another gate"): the existing-ledger
      // branch above already rejects a same-`(principal, id)` RETRY whose
      // `sessionId` disagrees with the stored original, but a genuinely
      // NEW `(principal, id)` pair (no `existing` entry, reached only past
      // that whole block) had no check at all that `command.sessionId`
      // even matches THIS gate's own `sessionId` — a direct consumer of
      // the exported `createSteeringGate()` (never `submitSteeringCommand`
      // itself, which always constructs `command.sessionId` from the same
      // `sessionId` it looked this gate up by) could steer the wrong
      // session's gate on the very first admission, no idempotency
      // collision required. `'policy-denied'` is reused for the same
      // reason `expectedRevision` mismatch below reuses it: no ratified
      // reason fits "wrong gate" specifically.
      if (command.sessionId !== sessionId) {
        return {
          outcome: 'rejected',
          failure: { failedAt: context.now, reason: 'policy-denied' },
        };
      }

      if (command.deadline !== undefined) {
        const deadlineMs = Date.parse(command.deadline);
        // A malformed (non-ISO, unparseable) deadline parses to `NaN`, and
        // every comparison against `NaN` is `false` — so a naive `now >
        // deadline` check silently ADMITS a command whose deadline could
        // not even be understood, rather than rejecting it (review finding,
        // PR #430 — Codex P2, "Reject malformed deadline timestamps"). Fails
        // closed: an unparseable deadline is treated exactly like one
        // already in the past.
        if (Number.isNaN(deadlineMs) || Date.parse(context.now) > deadlineMs) {
          return {
            outcome: 'rejected',
            failure: { failedAt: context.now, reason: 'deadline-passed' },
          };
        }
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== rawConfigVersion) {
        return {
          outcome: 'rejected',
          failure: { failedAt: context.now, reason: 'policy-denied' },
        };
      }

      const target = command.requestedValue.target;

      if (target === 'pause' || target === 'resume') {
        let boundRunId: string;
        if (command.runId !== undefined) {
          if (!context.liveRunIds.includes(command.runId)) {
            return {
              outcome: 'rejected',
              failure: { failedAt: context.now, reason: 'run-terminal' },
            };
          }
          boundRunId = command.runId;
        } else if (context.liveRunIds.length === 1) {
          boundRunId = context.liveRunIds[0] ?? UNBOUND;
        } else {
          // AB-67's ratified rule, verbatim: absent runId with ZERO or more
          // than one non-terminal run is ambiguous — zero is not a silent
          // fallback. Zero is unreachable from `submitSteeringCommand`
          // (its own pre-admission check already rejects a terminal session
          // before calling in); reachable only from a direct `admit()` call
          // with an empty `liveRunIds` (this module's own tests).
          return {
            outcome: 'rejected',
            failure: { failedAt: context.now, reason: 'run-ambiguous' },
          };
        }
        const alreadyAtTarget =
          target === 'pause' ? pausedRunIds.has(boundRunId) : !pausedRunIds.has(boundRunId);
        if (alreadyAtTarget) {
          // AB-67's ratified idempotency rule: a second pause while already
          // paused (or a resume while already unpaused) is accepted as a
          // no-op — no new configVersion, no state change.
          const stored = record(command, boundRunId, runVisibleVersion(boundRunId), context.now);
          if (target === 'pause') {
            // A DISTINCT pause command admitted while the run is already
            // paused is a genuine, additional owner of the pause — the run
            // must stay paused until every such owner has either resumed
            // or expired, not merely the FIRST one (review finding, PR
            // #430 — Codex P2, "Keep a valid duplicate pause when the
            // owner expires"). See `addPauseOwner`'s own doc comment.
            addPauseOwner(boundRunId, command.principal, command.id);
          }
          return { outcome: 'accepted', command: snapshotOf(stored) };
        }
        const version = bump();
        effectiveConfigVersion = version;
        runLastPauseVersion.set(boundRunId, version);
        if (target === 'pause') {
          pausedRunIds.add(boundRunId);
        } else {
          pausedRunIds.delete(boundRunId);
          releaseWaitersFor(boundRunId);
          releaseUnboundWaitersIfFullyResumed();
        }
        const stored = record(command, boundRunId, version, context.now);
        // This is a genuinely NEW transition for `boundRunId` — the run's
        // next boundary read will observe THIS version, never an earlier
        // one. Every PREVIOUS owner of this run's pause still `accepted`
        // (the run's own boundary never reached it before this transition
        // overtook it) is now stale: mark each `superseded`, the same
        // terminal-failure AB-67 already fixes for exactly this "a later
        // command replaces an earlier one before it ever applied" shape
        // (review finding, PR #430 — Codex P2, "Do not mark skipped
        // steering versions as applied"). See `runPauseOwners`'s own doc
        // comment for why this is now every current owner, not one.
        clearPauseOwners(boundRunId, context.now, command.id);
        if (target === 'pause') addPauseOwner(boundRunId, command.principal, command.id);
        return { outcome: 'accepted', command: snapshotOf(stored) };
      }

      // agent-identity: reachable only via a direct `admit()` call, never
      // through `submitSteeringCommand` (see `ImplementedSteeringCommand`'s
      // doc comment). Resolving a `policyRef` against AB-66's catalog is
      // `ab-67-bureau-b` (AB-200)'s job, explicitly out of THIS issue's own
      // scope — admitting a `policyRef` command here anyway would silently
      // accept a command that never actually changes `agentName` (nothing
      // in this module resolves a `policyRef` to a concrete name), a
      // command that LOOKS admitted but has no real effect (review finding,
      // PR #430 — Codex P2, "Reject unresolved policyRef identity
      // commands"). Only the `override` variant — a caller-supplied,
      // already-concrete agent name needing no catalog resolution — is
      // admitted; `policyRef` returns the identical `unsupported-capability`
      // reason `submitSteeringCommand` itself already returns for every
      // other target `ab-67-bureau-b` owns.
      if (
        !('override' in command.requestedValue) ||
        command.requestedValue.override === undefined
      ) {
        return { outcome: 'unsupported-capability', reason: 'selector-unavailable' };
      }

      // Bumps the raw counter (AB-67: "increments by exactly one on every
      // command that reaches accepted") but does NOT advance
      // `effectiveConfigVersion` — its application boundary is step 0 of the
      // session's NEXT run, not this boundary read, so `getDesiredState()`
      // must not report it as current until `promoteForNewRun()` runs.
      const version = bump();
      // A replacement identity command supersedes the still-pending one,
      // rather than silently overwriting `pendingAgentName` and leaving the
      // superseded command's own ledger entry stuck `accepted` forever
      // (review finding, PR #430 — Codex P2, "Supersede earlier pending
      // identity commands").
      if (pendingIdentityKey !== undefined) {
        const prior = ledgerGet(pendingIdentityKey.principal, pendingIdentityKey.id);
        if (prior && prior.state === 'accepted') {
          prior.state = 'superseded';
          prior.failure = {
            failedAt: context.now,
            reason: 'superseded-by',
            supersededBy: command.id,
          };
        }
      }
      // Guaranteed present — the `policyRef` variant already returned above.
      pendingAgentName = command.requestedValue.override;
      pendingAgentDeadline = command.deadline;
      const stored = record(command, undefined, version, context.now);
      pendingIdentityKey = { principal: command.principal, id: command.id };
      lastIdentityVersion = version;
      return { outcome: 'accepted', command: snapshotOf(stored) };
    },

    recordApplied(runId: string, configVersion: number, now: string): void {
      if (configVersion > appliedFloor) appliedFloor = configVersion;
      // The per-run counterpart of `appliedFloor` above — see its own doc
      // comment for why `record()` must read THIS, not the session-wide
      // floor, for a run-scoped pause/resume command.
      if (configVersion > (runAppliedVersion.get(runId) ?? 0)) {
        runAppliedVersion.set(runId, configVersion);
      }
      // An agent-identity command is eligible for THIS run only if it was
      // already committed by the time `runId` STARTED — its own baseline —
      // never merely at or below whatever `configVersion` this boundary
      // happens to report right now (which can be inflated past a LATER,
      // still-deferred identity command by an in-run pause/resume bound to
      // this same run). See this method's own doc comment.
      const baseline = runBaseline.get(runId) ?? 0;
      const owners = runPauseOwners.get(runId);
      for (const principalMap of ledger.values()) {
        for (const stored of principalMap.values()) {
          if (stored.sessionId !== sessionId) continue;
          if (stored.state !== 'accepted') continue;
          const isIdentity =
            stored.runId === undefined && stored.requestedValue.target === 'agent-identity';
          const isPause = stored.runId === runId && stored.requestedValue.target === 'pause';
          const eligible = isIdentity
            ? stored.configVersion <= baseline
            : // Exact match, not `<=`: a pause/resume the run's boundary
              // never actually observed — because a LATER transition on the
              // same run overtook it first, before this boundary ever fired
              // — must not be misreported as `applied` merely because its
              // version is numerically at or below the version this
              // boundary DID observe. `admit()`'s `clearPauseOwners`
              // supersession already marks that stale command `superseded`
              // the moment it is overtaken (so it is normally no longer
              // `accepted` by the time this runs at all); this exact match
              // is the belt to that suspenders (review finding, PR #430 —
              // Codex P2, "Do not mark skipped steering versions as
              // applied").
              stored.runId === runId && stored.configVersion === configVersion;
          if (!eligible) continue;
          // Deadline expiry at application time applies to agent-identity
          // (deferred effect — the deadline must prevent it from ever taking
          // effect) and to `pause` (immediate effect at admission, but an
          // expired pause must actually STOP pausing, not stay silently
          // stuck): `resume` is excluded — its "effect" already happened at
          // ADMISSION (`pausedRunIds` cleared, waiters released) and there
          // is nothing to revert; re-checking its deadline here would only
          // produce a contradictory `failed`-but-already-unblocked record
          // with no corrective action available (review finding, PR #430 —
          // Codex P1, "Revert expired commands' desired-state changes", and
          // the coordinator follow-up narrowing it to `pause` specifically).
          if (
            (isIdentity || isPause) &&
            stored.deadline !== undefined &&
            Date.parse(now) > Date.parse(stored.deadline)
          ) {
            // Only a command that is actually one of this run's current
            // pause OWNERS may revert anything on expiry, and reverting
            // means removing just ITSELF from the owner set — the run
            // stays paused as long as at least one other owner remains
            // unexpired (review finding, PR #430 — Codex P2, "Do not
            // release pauses owned by another command", and its converse,
            // "Keep a valid duplicate pause when the owner expires": a
            // duplicate idempotent replay, or a second distinct pause
            // admitted while already paused, is itself an owner and must
            // both avoid releasing a pause it does not solely hold AND
            // keep the pause held when it is the LAST owner remaining).
            const ownerKey = pauseOwnerKey(stored.principal, stored.id);
            const isOwner = isPause && owners !== undefined && owners.has(ownerKey);
            if (isOwner) {
              owners?.delete(ownerKey);
              if ((owners?.size ?? 0) === 0 && pausedRunIds.has(runId)) {
                pausedRunIds.delete(runId);
                releaseWaitersFor(runId);
                releaseUnboundWaitersIfFullyResumed();
              }
            }
            stored.state = 'failed';
            stored.failure = { failedAt: now, reason: 'deadline-passed' };
            continue;
          }
          stored.state = 'applied';
        }
      }
    },

    promoteForNewRun(runId: string, now: string = new Date().toISOString()): void {
      // A still-`accepted` pending identity command whose deadline already
      // passed by `now` must be REJECTED, never promoted — its effect is
      // genuinely deferred until this exact moment, so a deadline that
      // passed in the interim must prevent it from ever taking effect,
      // mirroring `recordApplied`'s own identical application-time deadline
      // enforcement for a command whose effect is not deferred (review
      // finding, PR #430 — Codex P2, "Reject expired identities before
      // promoting them": promotion previously committed the desired-state
      // change unconditionally, before any deadline check ever ran).
      if (pendingIdentityKey !== undefined) {
        const pending = ledgerGet(pendingIdentityKey.principal, pendingIdentityKey.id);
        if (
          pending &&
          pending.state === 'accepted' &&
          pending.deadline !== undefined &&
          Date.parse(now) > Date.parse(pending.deadline)
        ) {
          pending.state = 'failed';
          pending.failure = { failedAt: now, reason: 'deadline-passed' };
          pendingAgentName = undefined;
        }
      }
      if (pendingAgentName !== undefined) {
        agentName = pendingAgentName;
        agentNameDeadline = pendingAgentDeadline;
        pendingAgentName = undefined;
        pendingAgentDeadline = undefined;
      }
      // Unconditional, not only inside the `pendingAgentName !== undefined`
      // branch above: a `policyRef`-only identity command sets
      // `pendingIdentityKey` without ever touching `pendingAgentName` (see
      // `admit()`'s identity branch), and either way, once a run has
      // promoted whatever was pending, that command is no longer a valid
      // supersession target — it is already the run's own effective
      // identity, not something still awaiting promotion (review finding,
      // PR #430 — Codex P2, "Clear the pending identity key when promoting
      // it": leaving the key set let a LATER identity command wrongly mark
      // an already-effective one `superseded`).
      pendingIdentityKey = undefined;
      effectiveConfigVersion = rawConfigVersion;
      // Seeded from `lastIdentityVersion`, not `rawConfigVersion` — see
      // `lastIdentityVersion`'s own doc comment.
      runBaseline.set(runId, lastIdentityVersion);
      // Captured for THIS run specifically — see `runAgentName`'s and
      // `forRun`'s own doc comments for why a later promotion for a
      // different run must never change what this run reports.
      if (agentName !== undefined) {
        runAgentName.set(runId, agentName);
        if (agentNameDeadline !== undefined) runAgentDeadline.set(runId, agentNameDeadline);
        else runAgentDeadline.delete(runId);
      }
    },

    failAcceptedForRun(runId: string, now: string): void {
      releaseRun(runId, now);
    },

    settleForDeletion(now: string): void {
      // Every run this gate still has ANY bookkeeping for — not only
      // `pausedRunIds` — since a run that started but never paused still
      // holds a `runBaseline`/`runPauseOwners`/`waitersByRunId` entry this
      // gate is about to discard along with everything else (see this
      // method's own interface doc comment).
      const runIds = new Set<string>([
        ...pausedRunIds,
        ...runBaseline.keys(),
        ...runLastPauseVersion.keys(),
        ...runPauseOwners.keys(),
        ...waitersByRunId.keys(),
      ]);
      for (const runId of runIds) releaseRun(runId, now);
    },

    purgeFromLedger(): void {
      for (const [principal, principalMap] of ledger) {
        for (const [id, stored] of principalMap) {
          if (stored.sessionId === sessionId) principalMap.delete(id);
        }
        if (principalMap.size === 0) ledger.delete(principal);
      }
    },
  };

  // Shared by `failAcceptedForRun` (one terminating run) and
  // `settleForDeletion` (every run this gate still tracks, at once): fails
  // every still-`accepted` pause/resume bound to `runId`, unconditionally
  // releases its pause binding and waiters, and drops every per-run
  // bookkeeping entry — see `failAcceptedForRun`'s own interface doc
  // comment for why the release is unconditional even once `recordApplied`
  // has already promoted the command, and `settleForDeletion`'s for why a
  // deleted session's paused run must not be left with no way to ever
  // resume.
  function releaseRun(runId: string, now: string): void {
    for (const principalMap of ledger.values()) {
      for (const stored of principalMap.values()) {
        if (
          stored.sessionId === sessionId &&
          stored.state === 'accepted' &&
          stored.runId === runId &&
          (stored.requestedValue.target === 'pause' || stored.requestedValue.target === 'resume')
        ) {
          stored.state = 'failed';
          stored.failure = { failedAt: now, reason: 'run-terminal' };
        }
      }
    }
    if (pausedRunIds.has(runId)) {
      pausedRunIds.delete(runId);
      releaseWaitersFor(runId);
      releaseUnboundWaitersIfFullyResumed();
    }
    // Every in-memory run this gate has ever seen otherwise leaves a
    // permanent bookkeeping entry, growing unboundedly for a long-lived
    // session that runs many sequential runs (review finding, PR #430 —
    // Codex P2, "Remove terminal runs from gate bookkeeping"). Safe to drop
    // here: this run is now terminal, so nothing will call
    // `forRun(runId)`, `recordApplied(runId, ...)`, or `awaitResume()`
    // through this run's view again.
    runBaseline.delete(runId);
    runLastPauseVersion.delete(runId);
    runAppliedVersion.delete(runId);
    runPauseOwners.delete(runId);
    runAgentName.delete(runId);
    runAgentDeadline.delete(runId);
    waitersByRunId.delete(runId);
  }

  return gate;
}
