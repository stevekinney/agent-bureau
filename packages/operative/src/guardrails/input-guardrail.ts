import { runDetectorPipeline } from 'armorer';

import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, PrepareStepHook, StepContext } from '../types';
import type { DetectorContext, GuardrailTriggeredEvent, InputGuardrailOptions } from './types';

/**
 * Extracts the text content of the last user message from a conversation.
 */
function getLastUserMessageText(context: StepContext): string {
  const messages = context.conversation.getMessages();
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return '';
  return typeof lastUser.content === 'string' ? lastUser.content : '';
}

/**
 * Creates a refusal response that short-circuits the generate call.
 */
function createBlockResponse(): GenerateResponse {
  return {
    content: 'Request blocked by input guardrail: the input was flagged as a policy violation.',
    toolCalls: [],
  };
}

/**
 * Creates an input guardrail hook that inspects user messages before each generate step.
 *
 * Detectors run against the last user message. When a detector triggers, the configured
 * action determines the behavior:
 * - `'block'` (default): returns a `GenerateResponse` with refusal text, short-circuiting generate
 * - `'warn'`: calls `onTriggered` but allows the request through
 * - `'sanitize'`: replaces the last user message with the detector's sanitized version
 * - `'tripwire'`: throws a `GuardrailTripwireError`, hard-halting the run before the
 *   generate call fires (see `createGuardrails({ mode: 'tripwire' })`)
 *
 * Detector errors are caught via `Promise.allSettled` to prevent a broken detector
 * from crashing the agent loop.
 */
export function createInputGuardrail(options: InputGuardrailOptions): PrepareStepHook {
  const {
    detectors,
    action = 'block',
    onTriggered,
    mode = 'parallel',
    getSessionTainted,
  } = options;

  return async (context: StepContext): Promise<void | GenerateResponse> => {
    const input = getLastUserMessageText(context);
    if (!input) return;

    const messages = context.conversation.getMessages();
    const detectorContext: DetectorContext = {
      step: context.step,
      conversationLength: messages.length,
      sessionTainted: getSessionTainted?.() ?? false,
      provenance: 'user-input',
    };

    const topResult = await runDetectorPipeline(input, detectors, detectorContext, mode);

    if (!topResult) return;

    const event: GuardrailTriggeredEvent = {
      detector: topResult.detectorName,
      category: topResult.result.category,
      confidence: topResult.result.confidence,
      action,
      input,
      detail: topResult.result.detail,
      provenance: detectorContext.provenance,
    };

    onTriggered?.(event);

    if (action === 'tripwire') {
      throw new GuardrailTripwireError(
        `Input guardrail tripwire: "${topResult.detectorName}" flagged the request (${topResult.result.category}).`,
        {
          guardrailName: topResult.detectorName,
          category: topResult.result.category,
          phase: 'input',
          confidence: topResult.result.confidence,
          detail: topResult.result.detail,
        },
      );
    }

    if (action === 'warn') {
      return;
    }

    if (action === 'sanitize' && topResult.result.sanitized) {
      // Replace the last user message content with the sanitized version.
      // redactMessageAtPosition replaces the message content in-place (using
      // the sanitized text as the placeholder) rather than appending a new message.
      const allMessages = context.conversation.getMessages();
      let lastUserPosition = -1;
      for (let index = allMessages.length - 1; index >= 0; index--) {
        const message = allMessages[index];
        if (message?.role !== 'user') continue;
        lastUserPosition = index;
        break;
      }
      if (lastUserPosition >= 0) {
        context.conversation.redactMessageAtPosition(lastUserPosition, topResult.result.sanitized);
      }
      return;
    }

    // Default: block (also fallback when sanitize has no sanitized text)
    return createBlockResponse();
  };
}
