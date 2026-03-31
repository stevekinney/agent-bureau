import { describe, expect, it, mock } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createInputGuardrail } from './input-guardrail';
import type {
  DetectionResult,
  DetectorContext,
  GuardrailTriggeredEvent,
  InputDetector,
} from './types';

function createMockDetector(name: string, result: DetectionResult): InputDetector {
  return {
    name,
    detect: async () => result,
  };
}

function createMockStepContext(userMessage = 'Hello') {
  const conversation = new Conversation();
  conversation.appendUserMessage(userMessage);
  return {
    conversation,
    step: 1,
  };
}

const triggeredResult: DetectionResult = {
  triggered: true,
  confidence: 0.9,
  category: 'test-category',
  detail: 'Test detection',
};

const safeResult: DetectionResult = {
  triggered: false,
  confidence: 0,
  category: 'test-category',
};

describe('createInputGuardrail', () => {
  describe('action: block (default)', () => {
    it('returns a GenerateResponse with refusal text when a detector triggers', async () => {
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({ detectors: [detector] });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
      expect(result?.toolCalls).toEqual([]);
    });

    it('returns void when no detector triggers', async () => {
      const detector = createMockDetector('test-detector', safeResult);
      const hook = createInputGuardrail({ detectors: [detector] });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when blocking', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        onTriggered,
      });

      const context = createMockStepContext('bad input');
      await hook(context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event).toBeDefined();
      expect(event.detector).toBe('test-detector');
      expect(event.action).toBe('block');
    });
  });

  describe('action: warn', () => {
    it('returns void (allows through) when a detector triggers', async () => {
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'warn',
      });

      const context = createMockStepContext();
      const result = await hook(context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when warning', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const detector = createMockDetector('test-detector', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'warn',
        onTriggered,
      });

      const context = createMockStepContext();
      await hook(context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.action).toBe('warn');
    });
  });

  describe('action: sanitize', () => {
    it('modifies the last user message when a detector provides a sanitized version', async () => {
      const detector: InputDetector = {
        name: 'sanitizer',
        detect: async () => ({
          triggered: true,
          confidence: 0.8,
          category: 'sanitize-test',
          sanitized: 'cleaned input',
        }),
      };
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const context = createMockStepContext('dirty input');
      const result = await hook(context);

      // Sanitize returns void (continues to generate)
      expect(result).toBeUndefined();

      // The conversation should have the sanitized content appended
      const messages = context.conversation.getMessages();
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
      expect(lastUserMessage?.content).toBe('cleaned input');
    });

    it('blocks when no sanitized version is available', async () => {
      const detector = createMockDetector('test-detector', {
        ...triggeredResult,
        sanitized: undefined,
      });
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const context = createMockStepContext();
      const result = await hook(context);

      // Falls back to block when no sanitized version is available
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });
  });

  describe('multiple detectors', () => {
    it('triggers on the first detected violation in sequential mode', async () => {
      const firstCalls: number[] = [];
      const secondCalls: number[] = [];
      const first: InputDetector = {
        name: 'first',
        detect: async () => {
          firstCalls.push(1);
          return triggeredResult;
        },
      };
      const second: InputDetector = {
        name: 'second',
        detect: async () => {
          secondCalls.push(1);
          return safeResult;
        },
      };
      const hook = createInputGuardrail({
        detectors: [first, second],
        mode: 'sequential',
      });

      const context = createMockStepContext();
      const result = await hook(context);
      expect(result).toBeDefined();
      expect(firstCalls).toHaveLength(1);
      expect(secondCalls).toHaveLength(0);
    });

    it('runs all detectors in parallel mode (default)', async () => {
      const onTriggered = mock((_event: GuardrailTriggeredEvent) => {});
      const first = createMockDetector('first', triggeredResult);
      const second = createMockDetector('second', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [first, second],
        onTriggered,
      });

      const context = createMockStepContext();
      await hook(context);

      // In parallel mode, onTriggered is called for the highest-confidence result
      expect(onTriggered).toHaveBeenCalledTimes(1);
    });

    it('continues sequential evaluation after a detector throws', async () => {
      const broken: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('broken detector');
        },
      };
      const fallbackCalls: number[] = [];
      const fallback: InputDetector = {
        name: 'fallback',
        detect: async () => {
          fallbackCalls.push(1);
          return triggeredResult;
        },
      };
      const hook = createInputGuardrail({
        detectors: [broken, fallback],
        mode: 'sequential',
      });

      const result = await hook(createMockStepContext());

      expect(result).toBeDefined();
      expect(fallbackCalls).toHaveLength(1);
    });
  });

  describe('error resilience', () => {
    it('does not crash when a detector throws', async () => {
      const brokenDetector: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('detector crash');
        },
      };
      const hook = createInputGuardrail({ detectors: [brokenDetector] });

      const context = createMockStepContext();
      // Should not throw — detector errors are caught
      const result = await hook(context);
      expect(result).toBeUndefined();
    });

    it('still works when some detectors throw and others trigger', async () => {
      const brokenDetector: InputDetector = {
        name: 'broken',
        detect: async () => {
          throw new Error('detector crash');
        },
      };
      const workingDetector = createMockDetector('working', triggeredResult);
      const hook = createInputGuardrail({
        detectors: [brokenDetector, workingDetector],
      });

      const context = createMockStepContext();
      const result = await hook(context);
      expect(result).toBeDefined();
    });
  });

  describe('context construction', () => {
    it('passes correct detector context based on conversation state', async () => {
      const detectSpy = mock(async (_input: string, _ctx: DetectorContext) => safeResult);
      const detector: InputDetector = { name: 'spy', detect: detectSpy };
      const hook = createInputGuardrail({ detectors: [detector] });

      const conversation = new Conversation();
      conversation.appendUserMessage('first');
      conversation.appendAssistantMessage('reply');
      conversation.appendUserMessage('second');

      await hook({ conversation, step: 3 });

      expect(detectSpy).toHaveBeenCalledTimes(1);
      const args = detectSpy.mock.calls[0]!;
      const input = args[0];
      const ctx = args[1];
      expect(input).toBe('second');
      expect(ctx.step).toBe(3);
      expect(ctx.conversationLength).toBe(3);
    });

    it('sanitize mode is a no-op when there is no user message to redact', async () => {
      const detector: InputDetector = {
        name: 'sanitizer',
        detect: async () => ({
          triggered: true,
          confidence: 0.8,
          category: 'sanitize-test',
          sanitized: 'cleaned input',
        }),
      };
      const hook = createInputGuardrail({
        detectors: [detector],
        action: 'sanitize',
      });

      const conversation = new Conversation();
      conversation.appendAssistantMessage('No user message here');

      const result = await hook({ conversation, step: 1 });

      expect(result).toBeUndefined();
      expect(conversation.getMessages()).toHaveLength(1);
      expect(conversation.getMessages()[0]?.content).toBe('No user message here');
    });
  });
});
