import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { BudgetExceededError, ElicitationDeniedError, GuardrailTripwireError } from '../src/errors';
import type { OperativeHookMap } from '../src/hooks';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('expanded finish reasons', () => {
  it('ElicitationDeniedError in hook yields finishReason elicitation-denied', async () => {
    const result = await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        throw new ElicitationDeniedError('User declined');
      },
    });

    expect(result.finishReason).toBe('elicitation-denied');
    expect(result.error).toBeInstanceOf(ElicitationDeniedError);
  });

  it('BudgetExceededError in onCompact yields finishReason budget-exceeded', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('A message to increase token count');

    const result = await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      contextManagement: {
        maxTokens: 1,
        tokenEstimator: () => 100,
        onCompact: async () => {
          throw new BudgetExceededError('Token budget exceeded');
        },
      },
    });

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.error).toBeInstanceOf(BudgetExceededError);
  });

  it('run.completed event includes specialized finish reason', async () => {
    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        throw new ElicitationDeniedError('Denied');
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const completedEvents = recorder.events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0].detail as { finishReason: string }).finishReason).toBe(
      'elicitation-denied',
    );
  });

  it('generic errors still yield finishReason error', async () => {
    const result = await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        throw new Error('Something went wrong');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
  });

  it('existing finish reasons are unchanged', async () => {
    const stopConditionResult = await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    expect(stopConditionResult.finishReason).toBe('stop-condition');

    const maxStepsResult = await run({
      generate: async () => textResponse('Keep going'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    });
    expect(maxStepsResult.finishReason).toBe('maximum-steps');

    const controller = new AbortController();
    controller.abort('test');
    const abortedResult = await run({
      generate: async () => textResponse('Should not run'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
    });
    expect(abortedResult.finishReason).toBe('aborted');
  });

  it('BudgetExceededError in validateResponse yields finishReason budget-exceeded', async () => {
    const result = await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      validateResponse: async () => {
        throw new BudgetExceededError('Over budget');
      },
    });

    expect(result.finishReason).toBe('budget-exceeded');
  });

  describe('AB-40 — guardrail tripwires', () => {
    it('an input tripwire (prepareStep) halts the run BEFORE the generate call fires', async () => {
      let generateCalled = false;
      const result = await run({
        generate: async () => {
          generateCalled = true;
          return textResponse('Hello');
        },
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => {
          throw new GuardrailTripwireError('Injection detected', {
            guardrailName: 'prompt-injection',
            category: 'prompt-injection',
            phase: 'input',
            confidence: 0.95,
          });
        },
      });

      expect(generateCalled).toBe(false);
      expect(result.finishReason).toBe('tripwire');
      expect(result.error).toBeInstanceOf(GuardrailTripwireError);
      const error = result.error as GuardrailTripwireError;
      expect(error.guardrailName).toBe('prompt-injection');
      expect(error.phase).toBe('input');
    });

    it('an output tripwire (validateResponse) halts the run AFTER post-processing sees the response', async () => {
      const result = await run({
        generate: async () => textResponse('user@example.com'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        validateResponse: async (response) => {
          // Only trip when the validator has actually seen the generated content —
          // proves this fires post-processing, not pre-generate.
          if (response.content.includes('@')) {
            throw new GuardrailTripwireError('PII detected', {
              guardrailName: 'output-pii',
              category: 'pii',
              phase: 'output',
              confidence: 0.9,
            });
          }
        },
      });

      expect(result.finishReason).toBe('tripwire');
      const error = result.error as GuardrailTripwireError;
      expect(error.guardrailName).toBe('output-pii');
      expect(error.phase).toBe('output');
    });

    it('run.completed carries finishReason tripwire and a run.tripwire event names the guardrail', async () => {
      const activeRun = createActiveRun({
        generate: async () => textResponse('Hello'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => {
          throw new GuardrailTripwireError('Injection detected', {
            guardrailName: 'prompt-injection',
            category: 'prompt-injection',
            phase: 'input',
            confidence: 0.95,
            detail: 'matched 3 patterns',
          });
        },
      });

      const recorder = createRunRecorder(activeRun);
      await activeRun.result;

      const completedEvents = recorder.events.filter((e) => e.type === 'run.completed');
      expect(completedEvents).toHaveLength(1);
      expect((completedEvents[0].detail as { finishReason: string }).finishReason).toBe('tripwire');

      const tripwireEvents = recorder.events.filter((e) => e.type === 'run.tripwire');
      expect(tripwireEvents).toHaveLength(1);
      const tripwireDetail = tripwireEvents[0].detail as {
        guardrailName: string;
        category: string;
        phase: string;
        confidence: number;
        detail?: string;
      };
      expect(tripwireDetail.guardrailName).toBe('prompt-injection');
      expect(tripwireDetail.category).toBe('prompt-injection');
      expect(tripwireDetail.phase).toBe('input');
      expect(tripwireDetail.confidence).toBe(0.95);
      expect(tripwireDetail.detail).toBe('matched 3 patterns');
    });

    it('a tripwire hard-halts even when onError would otherwise retry/skip past it', async () => {
      // Regression guard (neuter-verified): the tripwire bypass in run-step.ts's
      // generate-phase catch must run BEFORE onError is consulted. Without that
      // bypass, this onError handler's 'skip' would swallow the tripwire and the
      // run would continue to a normal 'stop-condition' finish — defeating the
      // hard halt the tripwire is supposed to guarantee.
      let generateCallCount = 0;
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('onError', async () => 'skip');

      const result = await run({
        generate: async () => {
          generateCallCount++;
          return textResponse('Hello');
        },
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => {
          throw new GuardrailTripwireError('Injection detected', {
            guardrailName: 'prompt-injection',
            category: 'prompt-injection',
            phase: 'input',
            confidence: 0.95,
          });
        },
        hooks,
      });

      expect(result.finishReason).toBe('tripwire');
      expect(generateCallCount).toBe(0);
    });
  });
});
