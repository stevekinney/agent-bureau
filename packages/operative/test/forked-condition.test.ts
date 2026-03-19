import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { forked, noToolCalls, some } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse, StepResult } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

describe('forked', () => {
  it('does not stop when no fork event is emitted', () => {
    const conversation = new Conversation();
    const condition = forked();

    const result = condition(makeStepResult({ conversation }));

    expect(result).toBe(false);
  });

  it('stops after the session.forked event is emitted', () => {
    const conversation = new Conversation();
    const condition = forked();

    condition(makeStepResult({ conversation }));

    (conversation.emit as any)('session.forked', {
      action: 'session.forked',
      conversation: conversation.current,
      previousConversation: conversation.current,
    });

    const result = condition(makeStepResult({ conversation }));
    expect(result).toBe(true);
  });

  it('registers the listener only once across multiple evaluations', () => {
    const conversation = new Conversation();
    const condition = forked();

    condition(makeStepResult({ conversation }));
    condition(makeStepResult({ conversation }));
    condition(makeStepResult({ conversation }));

    (conversation.emit as any)('session.forked', {
      action: 'session.forked',
      conversation: conversation.current,
      previousConversation: conversation.current,
    });

    const result = condition(makeStepResult({ conversation }));
    expect(result).toBe(true);
  });

  it('remains true once detected', () => {
    const conversation = new Conversation();
    const condition = forked();

    condition(makeStepResult({ conversation }));

    (conversation.emit as any)('session.forked', {
      action: 'session.forked',
      conversation: conversation.current,
      previousConversation: conversation.current,
    });

    expect(condition(makeStepResult({ conversation }))).toBe(true);
    expect(condition(makeStepResult({ conversation }))).toBe(true);
  });

  it('stops the agent loop when fork event is emitted during onStep', async () => {
    const conversation = new Conversation();
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      toolCallResponse([weatherToolCall('Portland')]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation,
      stopWhen: forked(),
      maximumSteps: 10,
      onStep: async (stepResult) => {
        if (stepResult.step === 1) {
          (conversation.emit as any)('session.forked', {
            action: 'session.forked',
            conversation: conversation.current,
            previousConversation: conversation.current,
          });
        }
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });

  it('composes with some() alongside noToolCalls()', async () => {
    const conversation = new Conversation();
    const condition = some(forked(), noToolCalls());

    const result = await condition(makeStepResult({ conversation, toolCalls: [] }));
    expect(result).toBe(true);
  });

  it('composes with some() and forked() triggers the stop', async () => {
    const conversation = new Conversation();
    const condition = some(forked(), noToolCalls());

    const firstResult = await condition(
      makeStepResult({
        conversation,
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    expect(firstResult).toBe(false);

    (conversation.emit as any)('session.forked', {
      action: 'session.forked',
      conversation: conversation.current,
      previousConversation: conversation.current,
    });

    const secondResult = await condition(
      makeStepResult({
        conversation,
        toolCalls: [{ id: 'call-2', name: 'get_weather', arguments: { location: 'Seattle' } }],
      }),
    );
    expect(secondResult).toBe(true);
  });

  it('works with createRun', async () => {
    const conversation = new Conversation();
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      toolCallResponse([weatherToolCall('Portland')]),
      textResponse('Done'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation,
      stopWhen: forked(),
      maximumSteps: 10,
      onStep: async (stepResult) => {
        if (stepResult.step === 0) {
          (conversation.emit as any)('session.forked', {
            action: 'session.forked',
            conversation: conversation.current,
            previousConversation: conversation.current,
          });
        }
      },
    });

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(recorder.steps.length).toBeGreaterThanOrEqual(1);
  });
});
