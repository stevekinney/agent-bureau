import type { PrepareStepHook, ValidateResponseHook } from '../types';

/** Context provided to input detectors for situational awareness. */
export interface DetectorContext {
  step: number;
  conversationLength: number;
  sessionTainted: boolean;
}

/** Result of running an input detector against user input. */
export interface DetectionResult {
  triggered: boolean;
  confidence: number;
  category: string;
  detail?: string;
  sanitized?: string;
}

/** An input detector that inspects user messages for policy violations. */
export interface InputDetector {
  name: string;
  detect: (input: string, context: DetectorContext) => Promise<DetectionResult>;
}

/** Event emitted when an input guardrail is triggered. */
export interface GuardrailTriggeredEvent {
  detector: string;
  category: string;
  confidence: number;
  action: 'block' | 'warn' | 'sanitize';
  input: string;
  detail?: string;
}

/** Options for configuring input guardrails. */
export interface InputGuardrailOptions {
  detectors: InputDetector[];
  action?: 'block' | 'warn' | 'sanitize';
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
  mode?: 'parallel' | 'sequential';
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
  action: 'block' | 'warn' | 'redact';
  output: string;
  detail?: string;
}

/** Options for configuring output guardrails. */
export interface OutputGuardrailOptions {
  validators: OutputValidator[];
  action?: 'block' | 'warn' | 'redact';
  onTriggered?: (event: OutputGuardrailTriggeredEvent) => void;
  blockMessage?: string;
}

/** Event emitted when a session becomes tainted. */
export interface SessionTaintedEvent {
  reason: string;
  detector: string;
  confidence: number;
  step: number;
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
}

/** Hooks returned by the guardrails composition factory. */
export interface GuardrailHooks {
  prepareStep: PrepareStepHook;
  validateResponse: ValidateResponseHook;
}

/** State tracker for session tainting. */
export interface SessionTaintTracker {
  isTainted: () => boolean;
  taint: (event: SessionTaintedEvent) => void;
  getDetectors: () => InputDetector[];
  getValidators: () => OutputValidator[];
}
