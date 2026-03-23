import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { wallClockTimeout } from '../src/conditions/predicates';
import { run } from '../src/run';
import type { GenerateResponse, StepResult } from '../src/types';

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

const slowTool = createTool({
  name: 'slow_task',
  description: 'A slow task',
  input: z.object({}),
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return 'done';
  },
});

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('wallClockTimeout', () => {
  it('does not trigger before the timeout elapses', () => {
    const condition = wallClockTimeout(10_000);
    const result = condition(makeStepResult());
    expect(result).toBe(false);
  });

  it('triggers after the timeout elapses', async () => {
    const condition = wallClockTimeout(10);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = condition(makeStepResult());
    expect(result).toBe(true);
  });

  it('produces stop-condition finish reason in the loop', async () => {
    let callCount = 0;
    const generate = async (): Promise<GenerateResponse> => {
      callCount++;
      if (callCount <= 5) {
        // Each step takes ~50ms via the slow tool
        return toolCallResponse([{ name: 'slow_task', arguments: {} }]);
      }
      return textResponse('Should not reach here');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([slowTool]),
      conversation: new Conversation(),
      stopWhen: wallClockTimeout(100),
      maximumSteps: 20,
    });

    expect(result.finishReason).toBe('stop-condition');
    // Should have stopped before hitting maximumSteps
    expect(result.steps.length).toBeLessThan(20);
  });

  it('captures start time at creation, not first evaluation', async () => {
    const condition = wallClockTimeout(30);
    // Wait 40ms before first evaluation
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = condition(makeStepResult());
    expect(result).toBe(true);
  });
});
