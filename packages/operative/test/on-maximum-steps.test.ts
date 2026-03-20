import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('onMaximumSteps', () => {
  it('invokes the callback when the loop exits due to maximum steps', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      toolCallResponse([weatherToolCall('Portland')]),
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 3,
      onMaximumSteps: async () => {
        return 'I reached the step limit. Here is a summary.';
      },
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('I reached the step limit. Here is a summary.');
  });

  it('appends the returned string to the conversation', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
    ]);

    const conversation = new Conversation();
    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation,
      maximumSteps: 2,
      onMaximumSteps: async () => 'Final summary',
    });

    const messages = result.conversation.getMessages();
    const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
    expect(lastAssistant?.content).toBe('Final summary');
  });

  it('does not modify content when the callback returns void', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Checking Denver...'),
      toolCallResponse([weatherToolCall('Seattle')]),
    ]);

    let callbackInvoked = false;
    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 2,
      onMaximumSteps: async () => {
        callbackInvoked = true;
      },
    });

    expect(callbackInvoked).toBe(true);
    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('');
  });

  it('is not called when the loop exits via a stop condition', async () => {
    const generate = createMockGenerate([textResponse('Done')]);

    let callbackInvoked = false;
    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: (ctx) => ctx.toolCalls.length === 0,
      maximumSteps: 10,
      onMaximumSteps: async () => {
        callbackInvoked = true;
        return 'Should not appear';
      },
    });

    expect(callbackInvoked).toBe(false);
    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Done');
  });

  it('receives the correct step context', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
    ]);

    let receivedStep: number | undefined;
    const conversation = new Conversation();

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation,
      maximumSteps: 2,
      onMaximumSteps: async (context) => {
        receivedStep = context.step;
        return 'Summary';
      },
    });

    expect(receivedStep).toBe(2);
  });

  it('handles callback errors as run errors', async () => {
    const generate = createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 1,
      onMaximumSteps: async () => {
        throw new Error('Callback failed');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
  });

  it('works with createRun and emits run.completed', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
    ]);

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 2,
      onMaximumSteps: async () => 'Forced summary',
    });

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('Forced summary');

    const completedEvents = recorder.events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0].detail as { content: string }).content).toBe('Forced summary');
  });
});
