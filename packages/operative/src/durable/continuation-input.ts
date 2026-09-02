/**
 * The deterministic conversation-continuation shape ratified by AB-41's
 * scheduling and wait semantics decision record (2026-09-01), "Signal-based
 * operations" and "The decision says whether a wakeup continues the current
 * run..." sections. A durable park primitive (`requestHumanInput`'s
 * `ctx.waitForSignal`, or `scheduleWakeup`'s `ctx.sleep`) resumes the SAME run
 * with one more agent generation step; this module owns the plain, cloneable
 * input to that step and its rendering into the conversation as a synthetic
 * user-role message.
 *
 * Both halves are implemented here: the signal half (AB-44 — "resume agent
 * reasoning with a delivered signal payload") and the wakeup half (AB-45 —
 * "resume agent reasoning after a durable wakeup").
 */

/**
 * The captured input to the resumed generation step after a `requestHumanInput`
 * park is released by a delivered signal.
 *
 * Every field is plain and JSON-cloneable, so this type is safe to compute
 * inside a durable workflow body and carry across a checkpoint boundary
 * (unlike `Date.now()`/`new Date().toISOString()`, which are non-deterministic
 * and MUST NOT be read directly in workflow-body code — see AB-41's decision
 * record and the `run-workflow.ts` module doc's replay-determinism rules).
 */
export interface SignalContinuationInput<TPayload = unknown> {
  readonly kind: 'signal';
  /** The signal name the run parked on and that was delivered. */
  readonly signalName: string;
  /** The payload delivered with the signal, exactly as `ctx.waitForSignal` returned it. */
  readonly payload: TPayload;
  /**
   * ISO timestamp of delivery. Not read directly from `Date.now()`/
   * `new Date().toISOString()` in workflow-body code — that would be
   * non-deterministic across replay — the caller obtains it through a
   * checkpointed `ctx.memo` (or `ctx.run`) and passes it in. Carried on this
   * type per AB-41's ratified shape even though the fixed rendered message
   * does not include it (the rendering is keyed on `signalName`/`payload`/
   * `denied` only) — it is metadata for a caller inspecting the structured
   * input, not the transcript text.
   */
  readonly deliveredAt: string;
  /**
   * `true` when `payload` is the AB-46-ratified `requestHumanInput` denial
   * sentinel (`{ __abDenied: true, reason?: string }`) — see
   * {@link isDeniedSignalPayload}. AB-41's decision is explicit that a denial
   * is NOT exempted from the continuation step: it still renders as a signal
   * delivery, and the resumed generation step is expected to conclude the run.
   */
  readonly denied: boolean;
  /** Present only when `denied` is `true` and the sentinel carried a `reason`. */
  readonly denialReason?: string;
}

/**
 * The AB-46-ratified `requestHumanInput` denial sentinel shape. `resolveReview({
 * decision: 'deny' })` against a `human-wait` review delivers this payload on
 * the same channel the workflow is parked on
 * (`engine.signal(review.human-wait.signalName, denialPayload)`), per AB-41's
 * decision record. AB-46 owns actually sending it; this module owns detecting
 * it so the continuation renders `denied` text instead of the payload's raw
 * JSON.
 */
interface DeniedSignalSentinel {
  readonly __abDenied: true;
  readonly reason?: string;
}

/**
 * Type guard for {@link DeniedSignalSentinel}. A signal payload is `unknown` —
 * `requestHumanInput`/`signalSession` enforce no payload schema (AB-41's
 * decision, "Signal-based operations": "none enforced") — so this narrows
 * defensively rather than casting.
 */
export function isDeniedSignalPayload(value: unknown): value is DeniedSignalSentinel {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate['__abDenied'] !== true) return false;
  const reason = candidate['reason'];
  return reason === undefined || typeof reason === 'string';
}

/**
 * Build a {@link SignalContinuationInput} from a signal's raw delivered
 * payload. Detects the denial sentinel via {@link isDeniedSignalPayload} so
 * callers do not need to special-case it. `deliveredAt` must already be a
 * plain ISO string obtained through a checkpointed operation — see the
 * field's own doc.
 */
export function buildSignalContinuationInput<TPayload = unknown>(
  signalName: string,
  payload: TPayload,
  deliveredAt: string,
): SignalContinuationInput<TPayload> {
  if (isDeniedSignalPayload(payload)) {
    return {
      kind: 'signal',
      signalName,
      payload,
      deliveredAt,
      denied: true,
      ...(payload.reason !== undefined ? { denialReason: payload.reason } : {}),
    };
  }
  return {
    kind: 'signal',
    signalName,
    payload,
    deliveredAt,
    denied: false,
  };
}

/**
 * The captured input to the resumed generation step after a `scheduleWakeup`
 * park is released by its durable timer firing.
 *
 * Shape is AB-41's ratified `WakeupContinuationInput` verbatim (decision
 * record, "The decision says whether a wakeup continues the current run..."
 * section): exactly `kind`, `firedAt`, `requestedDuration`, and `note`. The
 * decision's own worked-example continuation-input module doc does not carry
 * a separately-computed "scheduled at" timestamp alongside `firedAt` — a
 * durable sleep has no missed-fire concept ("a durable sleep fires as soon as
 * the process observes its deadline has passed on recovery"), so there is no
 * second timestamp to reconstruct deterministically from workflow-body code.
 * `firedAt` is the one plain, checkpointed fact: when the resumed step
 * actually observed the timer had fired.
 */
export interface WakeupContinuationInput {
  readonly kind: 'wakeup';
  /**
   * ISO timestamp of when the fired wakeup was observed and the continuation
   * step begins. Like {@link SignalContinuationInput.deliveredAt}, obtained
   * through a checkpointed `ctx.memo` rather than a direct `Date.now()`/
   * `new Date().toISOString()` call in workflow-body code, which would be
   * non-deterministic across replay.
   */
  readonly firedAt: string;
  /** The `scheduleWakeup({ in })` duration this run parked on, exactly as requested. */
  readonly requestedDuration: number | string;
  /** The note the agent attached to the wakeup request, if any. */
  readonly note?: string;
}

/**
 * Build a {@link WakeupContinuationInput} from the {@link PendingWakeup} the
 * `scheduleWakeup` tool wrote and the `firedAt` timestamp obtained through a
 * checkpointed `ctx.memo`.
 */
export function buildWakeupContinuationInput(
  requestedDuration: number | string,
  note: string | undefined,
  firedAt: string,
): WakeupContinuationInput {
  return {
    kind: 'wakeup',
    firedAt,
    requestedDuration,
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * Render a duration (a Weft `Duration`: milliseconds as a number, or a
 * human-readable/ISO-8601 string) as human-readable text. Shared by
 * {@link renderWakeupContinuation} and `create-schedule-wakeup-tool.ts`'s
 * tool-result `message`, so the tool's confirmation message and the
 * continuation's rendered text describe the same requested duration the
 * same way.
 */
export function renderDurationLabel(duration: number | string): string {
  return typeof duration === 'number' ? `${duration}ms` : duration;
}

/**
 * Render a {@link WakeupContinuationInput} into the fixed, parseable text
 * AB-41's decision record specifies: `[wakeup] Resumed after sleeping
 * {humanReadableDuration}.{note ? ' Note: ' + note : ''}` — appended to the
 * conversation as a single synthetic user-role message, mirroring
 * {@link renderSignalContinuation} and the `appendAssistantMessage(finalContent)`
 * pattern at `run-workflow.ts`'s `onMaximumSteps` tail.
 */
export function renderWakeupContinuation(input: WakeupContinuationInput): string {
  const durationLabel = renderDurationLabel(input.requestedDuration);
  return `[wakeup] Resumed after sleeping ${durationLabel}.${
    input.note !== undefined ? ` Note: ${input.note}` : ''
  }`;
}

/** The fixed placeholder rendered in place of a payload `JSON.stringify` cannot represent
 *  (a `bigint`, a circular structure, or any other value that throws or is unrepresentable).
 *  A malformed/unserializable payload must never crash the durable workflow — the AC's
 *  "malformed payloads ... have explicit outcomes" is satisfied by this deterministic text
 *  rather than a thrown error inside the workflow body. */
const UNSERIALIZABLE_PAYLOAD_PLACEHOLDER = '[unserializable payload]';

/**
 * Render a {@link SignalContinuationInput} into the fixed, parseable text AB-41's
 * decision record specifies, appended to the conversation as a single synthetic
 * user-role message (mirroring the `appendAssistantMessage(finalContent)` pattern
 * at `run-workflow.ts`'s `onMaximumSteps` tail).
 *
 * - Ordinary delivery: `[signal:{signalName}] {JSON.stringify(payload)}`
 * - Denial with a reason: `[signal:{signalName}] denied: {denialReason}`
 * - Denial with no reason: `[signal:{signalName}] denied`
 *
 * `JSON.stringify` is guarded: a payload it cannot render (throws, or the
 * literal `undefined` return for values like `bigint`... actually `bigint`
 * throws; `undefined`/function/symbol return the JS value `undefined`, which
 * is rendered as the literal word `undefined` for a deterministic message —
 * only a throw falls back to the placeholder) never crashes the workflow body.
 */
export function renderSignalContinuation(input: SignalContinuationInput): string {
  if (input.denied) {
    return `[signal:${input.signalName}] denied${
      input.denialReason !== undefined ? `: ${input.denialReason}` : ''
    }`;
  }

  let rendered: string;
  try {
    rendered = String(JSON.stringify(input.payload));
  } catch {
    rendered = UNSERIALIZABLE_PAYLOAD_PLACEHOLDER;
  }
  return `[signal:${input.signalName}] ${rendered}`;
}
