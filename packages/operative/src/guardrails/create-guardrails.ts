import type { GenerateResponse, StepContext } from '../types';
import { createInputGuardrail } from './input-guardrail';
import { createOutputGuardrail } from './output-guardrail';
import { createSessionTaintTracker } from './session-taint';
import type { GuardrailHooks, GuardrailsOptions } from './types';

/** Default confidence threshold for tainting a session. */
const DEFAULT_TAINT_THRESHOLD = 0.9;

/**
 * Creates a coordinated pair of guardrail hooks (input + output) with session tainting.
 *
 * The factory wires together input detectors, output validators, and a session taint
 * tracker. When a high-confidence detection occurs, the session becomes tainted and
 * escalated detectors/validators are added to subsequent checks.
 *
 * `mode: 'tripwire'` switches both input and output guardrails to the
 * OpenAI-tripwire model: a tripped detector/validator throws a
 * `GuardrailTripwireError` (hard-halting the run) instead of substituting a
 * blocked/sanitized/redacted response. It overrides `input.action` /
 * `output.action` regardless of what they were individually set to, so
 * callers don't have to set the action on both.
 *
 * Returns `{ prepareStep, validateResponse }` hooks ready for use in `RunOptions`.
 */
export function createGuardrails(options: GuardrailsOptions): GuardrailHooks {
  const { input, output, taint, mode = 'validate' } = options;

  const taintThreshold = taint?.taintThreshold ?? DEFAULT_TAINT_THRESHOLD;
  const taintTracker = createSessionTaintTracker(taint);

  // Build the prepareStep hook
  const prepareStep = async (context: StepContext): Promise<void | GenerateResponse> => {
    if (!input) return;

    // Merge base detectors with any escalated detectors from taint
    const activeDetectors = [...input.detectors, ...taintTracker.getDetectors()];

    // Create a fresh guardrail with the current detector set (includes escalated if tainted)
    const hook = createInputGuardrail({
      ...input,
      detectors: activeDetectors,
      action: mode === 'tripwire' ? 'tripwire' : input.action,
      getSessionTainted: () => taintTracker.isTainted(),
      onTriggered: (event) => {
        // Wire taint: if confidence exceeds threshold, taint the session
        if (event.confidence >= taintThreshold) {
          taintTracker.taint({
            reason: event.detail ?? `Detection by ${event.detector}`,
            detector: event.detector,
            confidence: event.confidence,
            step: context.step,
          });
        }

        // Forward to user's onTriggered if provided
        input.onTriggered?.(event);
      },
    });

    return hook(context);
  };

  // Build the validateResponse hook
  const validateResponse = async (
    response: GenerateResponse,
    context: StepContext,
  ): Promise<GenerateResponse | void> => {
    // Merge base validators with any escalated validators from taint
    const baseValidators = output?.validators ?? [];
    const activeValidators = [...baseValidators, ...taintTracker.getValidators()];

    if (activeValidators.length === 0) return;

    const hook = createOutputGuardrail({
      ...output,
      validators: activeValidators,
      action: mode === 'tripwire' ? 'tripwire' : output?.action,
      onTriggered: (event) => {
        output?.onTriggered?.(event);
      },
    });

    return hook(response, context);
  };

  return { prepareStep, validateResponse };
}
