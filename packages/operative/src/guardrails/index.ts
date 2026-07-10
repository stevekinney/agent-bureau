// Built-in detectors and the detector pipeline live in `armorer`, shared with
// the retrieval surfaces (memory recall, ingested documents, skill
// resources). Re-exported here so existing `operative` consumers keep the
// same import path.
export { createGuardrails } from './create-guardrails';
export { createInputGuardrail } from './input-guardrail';
export { createOutputGuardrail } from './output-guardrail';
export { createSessionTaintTracker } from './session-taint';
export type {
  DetectionResult,
  DetectorContext,
  GuardrailHooks,
  GuardrailProvenance,
  GuardrailsOptions,
  GuardrailTriggeredEvent,
  InputDetector,
  InputGuardrailOptions,
  OutputGuardrailOptions,
  OutputGuardrailTriggeredEvent,
  OutputValidator,
  SessionTaintedEvent,
  SessionTaintOptions,
  SessionTaintTracker,
  ValidationResult,
  ValidatorContext,
} from './types';
export type { CodeSafetyValidatorOptions } from './validators/code-safety';
export { createCodeSafetyValidator } from './validators/code-safety';
export type { GroundingValidatorOptions } from './validators/grounding';
export { createGroundingValidator } from './validators/grounding';
export { createOutputPIIValidator } from './validators/output-pii';
export type {
  InputLengthDetectorOptions,
  PromptInjectionDetectorOptions,
  TopicBoundaryDetectorOptions,
} from 'armorer';
export {
  createInputLengthDetector,
  createPromptInjectionDetector,
  createTopicBoundaryDetector,
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  withMinimumTripwireConfidence,
} from 'armorer';
