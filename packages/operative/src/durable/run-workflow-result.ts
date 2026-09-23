import type { AgentRunErrorCode, AgentRunErrorKind } from '../errors';
import { BudgetExceededError, ElicitationDeniedError, GuardrailTripwireError } from '../errors';
import {
  UnsupportedRunResultLegacyFieldError,
  UnsupportedRunResultVersionError,
} from '../run-envelope';
import type { FinishReason } from '../types';

/** Plain, cloneable summary returned when the durable run completes. */
export const AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION = 2 as const;

export interface AgentRunWorkflowResult {
  schemaVersion: typeof AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION;
  runId: string;
  steps: number;
  content: string;
  finishReason: FinishReason;
  /**
   * Serialized message of the error that ended the run, when `finishReason` is
   * `error` / `elicitation-denied` / `budget-exceeded`. The live error object is
   * not cloneable across a checkpoint, so only its message survives; the adapter
   * rebuilds an `Error` from it so consumers (e.g. gateway's `lastError`) see the
   * real cause rather than a synthetic placeholder.
   */
  errorMessage?: string | undefined;
  /** Safe error classifier retained across durable serialization. */
  errorKind?: AgentRunErrorKind | undefined;
  errorCode?: AgentRunErrorCode | undefined;
  /** The abort reason, when `finishReason` is `aborted`. */
  abortReason?: string | undefined;
  /**
   * The structured-output validation outcome, when the run stopped after a
   * `output` was applied. Mirrors `RunResult.schemaValidation` on the
   * in-memory path; `success` — the load-bearing bit — is preserved exactly.
   *
   * KNOWN SEAM (structural fidelity of `error`): the in-memory path puts the
   * LIVE validation error in `schemaValidation.error` (typically a `ZodError`
   * with structured `.issues`); a live error is not cloneable across a
   * checkpoint, so the durable path serializes it to its message and the adapter
   * rebuilds a plain `Error(message)`. A consumer reading `error.issues` /
   * `error.name` therefore sees the structured error in-memory but a plain
   * `Error` on the durable path. This matches the same structural-vs-identity
   * boundary already accepted for terminal `RunResult.error` (stack/cause are
   * likewise reduced to a message) and for conversations (snapshots, not
   * instances). operative cannot faithfully reconstruct an arbitrary user
   * schema library's error type; `success` is the contract, the error shape is
   * best-effort.
   */
  schemaValidation?: { success: boolean; error?: string | undefined } | undefined;
  /**
   * The `output`-validated structured output, when the run stopped
   * after a `output` was applied AND validation succeeded. Mirrors
   * `RunResult.output` on the in-memory path. Unlike
   * `schemaValidation.error`, this is already plain (JSON-parsed and
   * validated) data, so it crosses the checkpoint boundary unchanged — no
   * serialize/reconstruct step is needed the way `schemaValidation.error`
   * needs one. (A Standard Schema validator whose `transform` produces a
   * non-JSON value, e.g. a `Date`, would NOT survive the checkpoint
   * faithfully — this is a durable-path constraint on schema authors, not a
   * bug: only JSON-serializable structured output round-trips.)
   */
  output?: unknown;
  /**
   * D6/AB-45 — The note from the LAST `scheduleWakeup` call the run genuinely
   * parked on and woke from (`yield* ctx.sleep(duration)` completed). Mirrors
   * `humanWaitSignal`'s contract exactly: a historical fact ("this run did
   * sleep on this wakeup"), not a live-park indicator — it remains set on the
   * FINAL result even after the fired wakeup continued the run with one more
   * generation step (or several, if the continuation itself re-parked), and
   * regardless of how the run eventually terminates. Absent when no wakeup
   * was ever genuinely parked on (including when a `scheduleWakeup` call was
   * pending at the moment of a terminal failure — that wakeup never fires,
   * see `isFailureOutcome`'s gate on the park block below) or when the fired
   * wakeup carried no note.
   */
  wakeupNote?: string | undefined;
  /**
   * F3 — The LAST signal name the run genuinely parked on via
   * `requestHumanInput` and was released for. Present once the workflow has
   * completed a `yield* ctx.waitForSignal(signalName)` (AB-44 — resume agent
   * reasoning with a delivered signal payload). This is a historical fact
   * ("this run did park on this signal"), not a live-park indicator — it
   * remains set on the FINAL result even after the delivered payload
   * continued the run with one more generation step (or several, if the
   * continuation itself re-parked), and regardless of how the run eventually
   * terminates. Callers can surface this so a later inspection knows which
   * signal most recently drove the run's resume.
   */
  humanWaitSignal?: string | undefined;
  /**
   * The tripped guardrail's identity, when `finishReason` is `'tripwire'`. The
   * live `GuardrailTripwireError` is not cloneable across a checkpoint, so its
   * identifying fields are carried here (plain, cloneable) and the adapter
   * rebuilds the error from them — mirroring `errorMessage`'s
   * serialize/rebuild contract for `elicitation-denied` / `budget-exceeded`.
   */
  tripwire?:
    | {
        guardrailName: string;
        category: string;
        phase: 'input' | 'output';
        confidence: number;
        detail?: string;
      }
    | undefined;
}

/**
 * Normalize a workflow summary at the durable trust boundary.
 */
export function normalizeAgentRunWorkflowResult(value: unknown): AgentRunWorkflowResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid durable agent run workflow result');
  }

  const summary = value as Record<string, unknown>;
  if (summary['schemaVersion'] !== AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION) {
    throw new UnsupportedRunResultVersionError(summary['schemaVersion']);
  }
  if ('structuredOutput' in summary) {
    throw new UnsupportedRunResultLegacyFieldError('structuredOutput', summary['schemaVersion']);
  }

  return value as AgentRunWorkflowResult;
}

/** Serialize an unknown error to a stable message string for the checkpoint. */
export function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Classify a terminal error into a {@link FinishReason}, identically to
 * `makeErrorResult` in run-lifecycle.ts. Called INSIDE the memo where the live
 * error object still exists (its class identity is lost once serialized across
 * the checkpoint), so the durable path distinguishes `elicitation-denied` and
 * `budget-exceeded` from a plain `error` exactly as the in-memory loop does.
 */
export function classifyErrorFinishReason(error: unknown): FinishReason {
  if (error instanceof ElicitationDeniedError) return 'elicitation-denied';
  if (error instanceof BudgetExceededError) return 'budget-exceeded';
  if (error instanceof GuardrailTripwireError) return 'tripwire';
  return 'error';
}

/**
 * Plain, cloneable projection of a {@link GuardrailTripwireError}'s identifying
 * fields, captured INSIDE the memo where the live error still exists (its
 * guardrail identity does not survive serialization across the checkpoint).
 * Carried on {@link AgentRunWorkflowResult} so the adapter can reconstruct the
 * error and fire `RunTripwireEvent` on the durable path exactly as the
 * in-memory loop does.
 */
export function tripwireDetailFrom(error: unknown): AgentRunWorkflowResult['tripwire'] {
  if (!(error instanceof GuardrailTripwireError)) return undefined;
  return {
    guardrailName: error.guardrailName,
    category: error.category,
    phase: error.phase,
    confidence: error.confidence,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
  };
}
