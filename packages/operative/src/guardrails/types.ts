import type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
} from 'armorer';

import type { PrepareStepHook, ValidateResponseHook } from '../types';

/**
 * `DetectorContext`, `DetectionResult`, `InputDetector`, `GuardrailTriggeredEvent`,
 * and `GuardrailProvenance` live in `armorer`'s guardrail detector pipeline —
 * the same pipeline reused by memory recall, ingested documents, and skill
 * resources so every surface that admits retrieved content into the model's
 * context runs through identical detection and confidence-gating logic.
 */
export type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
};

/** Options for configuring input guardrails. */
export interface InputGuardrailOptions {
  detectors: InputDetector[];
  /**
   * `'tripwire'` throws a `GuardrailTripwireError` instead of substituting a
   * blocked response — it hard-halts the run rather than letting the loop
   * continue. See `GuardrailsOptions.mode`, which sets this for you.
   */
  action?: 'block' | 'warn' | 'sanitize' | 'tripwire';
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
  mode?: 'parallel' | 'sequential';
  /** Getter that returns the current session taint state. When provided, detectors receive the live value. */
  getSessionTainted?: () => boolean;
}

/** Context provided to output validators. */
export interface ValidatorContext {
  step: number;
  conversationLength: number;
  toolCallCount: number;
}

/** Result of running an output validator against model output. */
export interface ValidationResult {
  valid: boolean;
  category: string;
  confidence: number;
  detail?: string;
  redacted?: string;
}

/** An output validator that inspects model responses for policy violations. */
export interface OutputValidator {
  name: string;
  validate: (output: string, context: ValidatorContext) => Promise<ValidationResult>;
}

/** Event emitted when an output guardrail is triggered. */
export interface OutputGuardrailTriggeredEvent {
  validator: string;
  category: string;
  confidence: number;
  action: 'block' | 'warn' | 'redact' | 'tripwire';
  output: string;
  detail?: string;
}

/** Options for configuring output guardrails. */
export interface OutputGuardrailOptions {
  validators: OutputValidator[];
  /**
   * `'tripwire'` throws a `GuardrailTripwireError` instead of substituting a
   * blocked/redacted response — it hard-halts the run rather than letting the
   * loop continue. See `GuardrailsOptions.mode`, which sets this for you.
   */
  action?: 'block' | 'warn' | 'redact' | 'tripwire';
  onTriggered?: (event: OutputGuardrailTriggeredEvent) => void;
  blockMessage?: string;
}

/** Event emitted when a session becomes tainted. */
export interface SessionTaintedEvent {
  reason: string;
  detector: string;
  confidence: number;
  step: number;
  /**
   * Where the content that caused the taint originated from. Defaults to
   * `'user-input'` for taints raised by the input guardrail hook; retrieval
   * surfaces (memory recall, ingested documents, skill resources) that feed
   * their own `GuardrailTriggeredEvent`s into a taint tracker should pass
   * their `event.provenance` through here.
   */
  provenance?: GuardrailProvenance;
}

/** Options for configuring session tainting behavior. */
export interface SessionTaintOptions {
  taintThreshold?: number;
  escalatedDetectors?: InputDetector[];
  escalatedValidators?: OutputValidator[];
  onTainted?: (event: SessionTaintedEvent) => void;
}

/** Combined options for the guardrails composition factory. */
export interface GuardrailsOptions {
  input?: InputGuardrailOptions;
  output?: OutputGuardrailOptions;
  taint?: SessionTaintOptions;
  /**
   * `'validate'` (default) — a tripped detector/validator substitutes a
   * blocked/sanitized/redacted response and the run continues, per each
   * guardrail's own `action`.
   *
   * `'tripwire'` — OpenAI-tripwire model: input detectors gate the first
   * generate call and output validators gate post-processing; a tripped wire
   * throws a `GuardrailTripwireError`, hard-halting the run with a clean
   * `finishReason: 'tripwire'` terminal result and a `run.tripwire` event
   * identifying the guardrail — distinct from `'validate'`'s retry/substitute
   * behavior. Overrides `input.action`/`output.action` to `'tripwire'`
   * regardless of what they were set to.
   */
  mode?: 'validate' | 'tripwire';
}

/** Hooks returned by the guardrails composition factory. */
export interface GuardrailHooks {
  prepareStep: PrepareStepHook;
  validateResponse: ValidateResponseHook;
  /**
   * The session's taint tracker. Retrieval surfaces outside operative's run
   * loop — memory recall, ingested documents, skill resources — don't go
   * through `prepareStep`/`validateResponse`, but their `scanContent()`
   * `onTriggered` callbacks can call `taint.taint(event)` directly to fold
   * their detections into the same session-wide taint state.
   */
  taint: SessionTaintTracker;
}

/** State tracker for session tainting. */
export interface SessionTaintTracker {
  isTainted: () => boolean;
  taint: (event: SessionTaintedEvent) => void;
  getDetectors: () => InputDetector[];
  getValidators: () => OutputValidator[];
}
