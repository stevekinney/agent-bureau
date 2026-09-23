// Built-in detectors and the detector pipeline live in `armorer`, shared with
// the retrieval surfaces (memory recall, ingested documents, skill
// resources). Re-exported here so existing `operative` consumers keep the
// same import path.
export {
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  createInputLengthDetector,
  createPromptInjectionDetector,
  createTopicBoundaryDetector,
  withMinimumTripwireConfidence,
} from 'armorer';
export type {
  InputLengthDetectorOptions,
  PromptInjectionDetectorOptions,
  TopicBoundaryDetectorOptions,
} from 'armorer';
export { createGuardrails } from './create-guardrails';
export { createInputGuardrail } from './input-guardrail';
export { createOutputGuardrail } from './output-guardrail';
export { createSessionTaintTracker } from './session-taint';
export type {
  DetectionResult,
  DetectorContext,
  GuardrailHooks,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  GuardrailsOptions,
  InputDetector,
  InputGuardrailOptions,
  OutputGuardrailOptions,
  OutputGuardrailTriggeredEvent,
  OutputValidator,
  SessionTaintOptions,
  SessionTaintTracker,
  SessionTaintedEvent,
  ValidationResult,
  ValidatorContext,
} from './types';
export { createCodeSafetyValidator } from './validators/code-safety';
export type { CodeSafetyValidatorOptions } from './validators/code-safety';
export { createGroundingValidator } from './validators/grounding';
export type { GroundingValidatorOptions } from './validators/grounding';
export { createOutputPIIValidator } from './validators/output-pii';
