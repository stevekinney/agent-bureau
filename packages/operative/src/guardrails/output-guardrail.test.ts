import { describe, expect, it, mock } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createOutputGuardrail } from './output-guardrail';
import type {
  OutputGuardrailTriggeredEvent,
  OutputValidator,
  ValidationResult,
  ValidatorContext,
} from './types';

function createMockValidator(name: string, result: ValidationResult): OutputValidator {
  return {
    name,
    validate: async () => result,
  };
}

function createMockStepContext() {
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello');
  return { conversation, step: 1 };
}

function createMockResponse(content = 'Response text') {
  return { content, toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }> };
}

const invalidResult: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'test-violation',
  detail: 'Test violation found',
};

const invalidWithRedaction: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'test-violation',
  detail: 'Test violation found',
  redacted: 'Redacted response text',
};

const validResult: ValidationResult = {
  valid: true,
  confidence: 0,
  category: 'test-check',
};

describe('createOutputGuardrail', () => {
  describe('action: block (default)', () => {
    it('returns a new GenerateResponse with refusal text when a validator triggers', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({ validators: [validator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
      expect(result?.toolCalls).toEqual([]);
    });

    it('returns void when all validators pass', async () => {
      const validator = createMockValidator('test-validator', validResult);
      const hook = createOutputGuardrail({ validators: [validator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeUndefined();
    });

    it('uses custom blockMessage when provided', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        blockMessage: 'Custom refusal message',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result?.content).toBe('Custom refusal message');
    });

    it('calls onTriggered callback when blocking', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        onTriggered,
      });

      const response = createMockResponse('original output');
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.validator).toBe('test-validator');
      expect(event.action).toBe('block');
      expect(event.output).toBe('original output');
    });
  });

  describe('action: warn', () => {
    it('returns void (passes through) when a validator triggers', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'warn',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when warning', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'warn',
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.action).toBe('warn');
    });
  });

  describe('action: redact', () => {
    it('returns a new GenerateResponse with redacted content', async () => {
      const validator = createMockValidator('test-validator', invalidWithRedaction);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'redact',
      });

      const response = createMockResponse('Original sensitive text');
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toBe('Redacted response text');
      expect(result?.toolCalls).toEqual([]);
    });

    it('falls back to block when no redacted version is available', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'redact',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });
  });

  describe('multiple validators', () => {
    it('triggers on the first failed validation', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const first = createMockValidator('first', invalidResult);
      const second = createMockValidator('second', validResult);
      const hook = createOutputGuardrail({
        validators: [first, second],
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
    });

    it('picks the highest-confidence failure', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const low: ValidationResult = { valid: false, confidence: 0.3, category: 'low' };
      const high: ValidationResult = { valid: false, confidence: 0.95, category: 'high' };
      const first = createMockValidator('low-validator', low);
      const second = createMockValidator('high-validator', high);
      const hook = createOutputGuardrail({
        validators: [first, second],
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      const event = onTriggered.mock.calls[0]![0];
      expect(event.validator).toBe('high-validator');
    });
  });

  describe('error resilience', () => {
    it('does not crash when a validator throws', async () => {
      const brokenValidator: OutputValidator = {
        name: 'broken',
        validate: async () => {
          throw new Error('validator crash');
        },
      };
      const hook = createOutputGuardrail({ validators: [brokenValidator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);
      expect(result).toBeUndefined();
    });

    it('still catches violations when some validators throw', async () => {
      const brokenValidator: OutputValidator = {
        name: 'broken',
        validate: async () => {
          throw new Error('validator crash');
        },
      };
      const workingValidator = createMockValidator('working', invalidResult);
      const hook = createOutputGuardrail({
        validators: [brokenValidator, workingValidator],
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);
      expect(result).toBeDefined();
    });
  });

  describe('context construction', () => {
    it('passes correct validator context', async () => {
      const validateSpy = mock(async (_output: string, _ctx: ValidatorContext) => validResult);
      const validator: OutputValidator = { name: 'spy', validate: validateSpy };
      const hook = createOutputGuardrail({ validators: [validator] });

      const conversation = new Conversation();
      conversation.appendUserMessage('first');
      conversation.appendAssistantMessage('reply');

      const response = createMockResponse();
      response.toolCalls = [
        { name: 'tool1', arguments: {} },
        { name: 'tool2', arguments: {} },
      ];

      await hook(response, { conversation, step: 5 });

      expect(validateSpy).toHaveBeenCalledTimes(1);
      const args = validateSpy.mock.calls[0]!;
      const output = args[0];
      const ctx = args[1];
      expect(output).toBe('Response text');
      expect(ctx.step).toBe(5);
      expect(ctx.conversationLength).toBe(2);
      expect(ctx.toolCallCount).toBe(2);
    });
  });
});
