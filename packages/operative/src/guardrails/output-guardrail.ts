import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, StepContext, ValidateResponseHook } from '../types';
import type {
  OutputGuardrailOptions,
  OutputGuardrailTriggeredEvent,
  ValidationResult,
  ValidatorContext,
} from './types';

const DEFAULT_BLOCK_MESSAGE =
  'Response blocked by output guardrail: the output was flagged as a policy violation.';

/**
 * Creates an output guardrail hook that inspects model responses after each generate step.
 *
 * Validators run against the response content. When a validator flags the output, the
 * configured action determines the behavior:
 * - `'block'` (default): returns a new `GenerateResponse` with refusal text
 * - `'warn'`: calls `onTriggered` but passes the original response through
 * - `'redact'`: returns a new `GenerateResponse` with the validator's redacted content
 * - `'tripwire'`: throws a `GuardrailTripwireError`, hard-halting the run right after
 *   post-processing flags the response (see `createGuardrails({ mode: 'tripwire' })`)
 *
 * Validator errors are caught via `Promise.allSettled` to prevent a broken validator
 * from crashing the agent loop.
 */
export function createOutputGuardrail(options: OutputGuardrailOptions): ValidateResponseHook {
  const {
    validators,
    action = 'block',
    onTriggered,
    blockMessage = DEFAULT_BLOCK_MESSAGE,
  } = options;

  return async (
    response: GenerateResponse,
    context: StepContext,
  ): Promise<GenerateResponse | void> => {
    const output = response.content;
    const messages = context.conversation.getMessages();
    const validatorContext: ValidatorContext = {
      step: context.step,
      conversationLength: messages.length,
      toolCallCount: response.toolCalls.length,
    };

    // Run all validators in parallel and collect results
    const settled = await Promise.allSettled(
      validators.map(async (validator) => ({
        result: await validator.validate(output, validatorContext),
        validatorName: validator.name,
      })),
    );

    // Find the highest-confidence failure
    let topFailure: { result: ValidationResult; validatorName: string } | undefined;

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && !outcome.value.result.valid) {
        if (!topFailure || outcome.value.result.confidence > topFailure.result.confidence) {
          topFailure = outcome.value;
        }
      }
    }

    if (!topFailure) return;

    const event: OutputGuardrailTriggeredEvent = {
      validator: topFailure.validatorName,
      category: topFailure.result.category,
      confidence: topFailure.result.confidence,
      action,
      output,
      detail: topFailure.result.detail,
    };

    onTriggered?.(event);

    if (action === 'tripwire') {
      throw new GuardrailTripwireError(
        `Output guardrail tripwire: "${topFailure.validatorName}" flagged the response (${topFailure.result.category}).`,
        {
          guardrailName: topFailure.validatorName,
          category: topFailure.result.category,
          phase: 'output',
          confidence: topFailure.result.confidence,
          detail: topFailure.result.detail,
        },
      );
    }

    if (action === 'warn') {
      return;
    }

    if (action === 'redact' && topFailure.result.redacted) {
      return {
        content: topFailure.result.redacted,
        toolCalls: [],
      };
    }

    // Default: block (also fallback when redact has no redacted text)
    return {
      content: blockMessage,
      toolCalls: [],
    };
  };
}
