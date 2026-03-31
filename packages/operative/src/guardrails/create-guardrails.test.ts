import { describe, expect, it, mock } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createGuardrails } from './create-guardrails';
import type {
  DetectionResult,
  InputDetector,
  OutputValidator,
  SessionTaintedEvent,
  ValidationResult,
} from './types';

function createMockDetector(name: string, result: DetectionResult): InputDetector {
  return { name, detect: async () => result };
}

function createMockValidator(name: string, result: ValidationResult): OutputValidator {
  return { name, validate: async () => result };
}

function createTestContext(userMessage = 'Hello') {
  const conversation = new Conversation();
  conversation.appendUserMessage(userMessage);
  return { conversation, step: 1 };
}

const triggeredDetection: DetectionResult = {
  triggered: true,
  confidence: 0.95,
  category: 'prompt-injection',
  detail: 'Injection detected',
};

const safeDetection: DetectionResult = {
  triggered: false,
  confidence: 0,
  category: 'prompt-injection',
};

const invalidValidation: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'pii',
  detail: 'PII found',
  redacted: 'Redacted text',
};

const validValidation: ValidationResult = {
  valid: true,
  confidence: 0,
  category: 'pii',
};

describe('createGuardrails', () => {
  it('returns prepareStep and validateResponse hooks', () => {
    const { prepareStep, validateResponse } = createGuardrails({});
    expect(typeof prepareStep).toBe('function');
    expect(typeof validateResponse).toBe('function');
  });

  describe('input guardrail integration', () => {
    it('blocks input when detector triggers', async () => {
      const detector = createMockDetector('test', triggeredDetection);
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });

    it('allows input when no detector triggers', async () => {
      const detector = createMockDetector('test', safeDetection);
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeUndefined();
    });
  });

  describe('output guardrail integration', () => {
    it('blocks output when validator triggers', async () => {
      const validator = createMockValidator('test', invalidValidation);
      const { validateResponse } = createGuardrails({
        output: { validators: [validator] },
      });

      const context = createTestContext();
      const response = {
        content: 'sensitive data',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });

    it('passes output when validator is clean', async () => {
      const validator = createMockValidator('test', validValidation);
      const { validateResponse } = createGuardrails({
        output: { validators: [validator] },
      });

      const context = createTestContext();
      const response = {
        content: 'safe text',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeUndefined();
    });
  });

  describe('session taint integration', () => {
    it('taints session when input detection confidence exceeds threshold', async () => {
      const onTainted = mock((_event: SessionTaintedEvent) => {});
      const detector = createMockDetector('injection', {
        ...triggeredDetection,
        confidence: 0.95,
      });
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
        taint: { taintThreshold: 0.9, onTainted },
      });

      const context = createTestContext();
      await prepareStep(context);

      expect(onTainted).toHaveBeenCalledTimes(1);
    });

    it('does not taint session when confidence is below threshold', async () => {
      const onTainted = mock((_event: SessionTaintedEvent) => {});
      const detector = createMockDetector('low', {
        triggered: true,
        confidence: 0.3,
        category: 'test',
      });
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector], action: 'warn' },
        taint: { taintThreshold: 0.9, onTainted },
      });

      const context = createTestContext();
      await prepareStep(context);

      expect(onTainted).not.toHaveBeenCalled();
    });

    it('adds escalated detectors after tainting', async () => {
      const escalatedDetectSpy = mock(async () => safeDetection);
      const escalatedDetector: InputDetector = {
        name: 'escalated',
        detect: escalatedDetectSpy,
      };

      let primaryCallCount = 0;
      const primaryDetector: InputDetector = {
        name: 'primary',
        detect: async () => {
          primaryCallCount++;
          // First call triggers and taints; subsequent calls are safe
          return primaryCallCount === 1 ? triggeredDetection : safeDetection;
        },
      };

      const { prepareStep } = createGuardrails({
        input: { detectors: [primaryDetector] },
        taint: {
          taintThreshold: 0.9,
          escalatedDetectors: [escalatedDetector],
        },
      });

      // First call: taints the session
      const context1 = createTestContext('injection attempt');
      await prepareStep(context1);

      // Second call: should include escalated detectors
      const context2 = createTestContext('normal message');
      await prepareStep(context2);

      expect(escalatedDetectSpy).toHaveBeenCalled();
    });

    it('adds escalated validators after tainting', async () => {
      const escalatedValidateSpy = mock(async () => validValidation);
      const escalatedValidator: OutputValidator = {
        name: 'escalated-v',
        validate: escalatedValidateSpy,
      };

      const detector = createMockDetector('trigger', triggeredDetection);

      const { prepareStep, validateResponse } = createGuardrails({
        input: { detectors: [detector] },
        output: { validators: [] },
        taint: {
          taintThreshold: 0.9,
          escalatedValidators: [escalatedValidator],
        },
      });

      // Taint via input
      const context1 = createTestContext('injection');
      await prepareStep(context1);

      // Now validate output — should include escalated validator
      const context2 = createTestContext('normal');
      const response = {
        content: 'response',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      await validateResponse(response, context2);

      expect(escalatedValidateSpy).toHaveBeenCalled();
    });
  });

  describe('empty configuration', () => {
    it('prepareStep is a no-op with no input config', async () => {
      const { prepareStep } = createGuardrails({});
      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeUndefined();
    });

    it('validateResponse is a no-op with no output config', async () => {
      const { validateResponse } = createGuardrails({});
      const context = createTestContext();
      const response = {
        content: 'text',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeUndefined();
    });
  });
});
