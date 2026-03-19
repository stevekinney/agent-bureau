import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createTestToolbox([weatherTool]);
}

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

describe('abort signal handling', () => {
  it('finishes with aborted reason when signal is already aborted before first turn', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    const generate = createMockGenerate([textResponse('Should not reach here')]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toHaveLength(0);
  });

  it('aborts between turns via onStep hook', async () => {
    const controller = new AbortController();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      signal: controller.signal,
      onStep: async ({ step }) => {
        if (step === 0) {
          controller.abort('user cancelled');
        }
      },
    });

    expect(result.finishReason).toBe('aborted');
    // The first step should have completed (onStep fires after the step)
    expect(result.steps).toHaveLength(1);
  });

  it('passes signal through to toolbox.execute via executeOptions', async () => {
    const controller = new AbortController();
    let executeCallCount = 0;

    const toolbox = createWeatherToolbox();
    const originalExecute = toolbox.execute.bind(toolbox);
    let receivedOptions: any;
    (toolbox as any).execute = async (...args: any[]) => {
      executeCallCount++;
      receivedOptions = args[1];
      return originalExecute(...args);
    };

    const conversation = new Conversation();
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });

    expect(executeCallCount).toBe(1);
    expect(receivedOptions?.signal).toBeDefined();
    expect(receivedOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns partial conversation state when aborted mid-run', async () => {
    const controller = new AbortController();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Step 0'),
      toolCallResponse([weatherToolCall('Seattle')], 'Step 1'),
      toolCallResponse([weatherToolCall('Portland')], 'Step 2'),
      textResponse('Done'),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      signal: controller.signal,
      onStep: async ({ step }) => {
        if (step === 1) {
          controller.abort('enough');
        }
      },
    });

    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].content).toBe('Step 0');
    expect(result.steps[1].content).toBe('Step 1');

    // Conversation should contain the partial messages
    const messages = result.conversation.getMessages();
    expect(messages.length).toBeGreaterThan(0);
  });

  it('does not call generate after the signal is aborted', async () => {
    const controller = new AbortController();

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      toolCallResponse([weatherToolCall('Portland')]),
      textResponse('Done'),
    ]);
    const toolbox = createWeatherToolbox();
    const conversation = new Conversation();

    await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      signal: controller.signal,
      onStep: async ({ step }) => {
        if (step === 0) {
          controller.abort('stop');
        }
      },
    });

    // Generate should have been called once for the first step,
    // and not called again after the abort.
    expect(generate.callCount).toBe(1);
  });
});
