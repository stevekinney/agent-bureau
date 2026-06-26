import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { BudgetExceededError, ElicitationDeniedError } from '../src/errors';
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
});
