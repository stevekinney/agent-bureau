import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createEarlyStoppingHandler } from '../src/create-early-stopping-handler';
import { createActiveRun } from '../src/create-run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateContext, GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

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

describe('createEarlyStoppingHandler', () => {
  it('calls generate without tools and returns the summary', async () => {
    const loopGenerate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
    ]);

    const summaryGenerate = async () => textResponse('Here is my summary of findings.');

    const result = await run({
      generate: loopGenerate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 2,
      onMaximumSteps: createEarlyStoppingHandler(summaryGenerate),
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('Here is my summary of findings.');
  });

  it('appends the default "provide your best answer" message', async () => {
    const loopGenerate = createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]);

    const messages: string[] = [];
    const summaryGenerate = async (context: GenerateContext) => {
      const allMessages = context.conversation.getMessages();
      const lastUser = allMessages.filter((m) => m.role === 'user').pop();
      if (lastUser) messages.push(String(lastUser.content));
      return textResponse('Summary');
    };

    await run({
      generate: loopGenerate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 1,
      onMaximumSteps: createEarlyStoppingHandler(summaryGenerate),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('step limit');
    expect(messages[0]).toContain('best answer');
  });

  it('uses a custom message when provided', async () => {
    const loopGenerate = createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]);

    const messages: string[] = [];
    const summaryGenerate = async (context: GenerateContext) => {
      const allMessages = context.conversation.getMessages();
      const lastUser = allMessages.filter((m) => m.role === 'user').pop();
      if (lastUser) messages.push(String(lastUser.content));
      return textResponse('Custom summary');
    };

    const result = await run({
      generate: loopGenerate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 1,
      onMaximumSteps: createEarlyStoppingHandler(summaryGenerate, {
        message: 'Wrap it up now.',
      }),
    });

    expect(result.content).toBe('Custom summary');
    expect(messages[0]).toBe('Wrap it up now.');
  });

  it('passes an empty toolbox to the summary generate call', async () => {
    const loopGenerate = createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]);

    let receivedToolbox: unknown;
    const summaryGenerate = async (context: GenerateContext) => {
      receivedToolbox = context.toolbox;
      return textResponse('Summary');
    };

    await run({
      generate: loopGenerate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 1,
      onMaximumSteps: createEarlyStoppingHandler(summaryGenerate),
    });

    expect(receivedToolbox).toBeDefined();
    expect((receivedToolbox as { tools: unknown[] }).tools).toHaveLength(0);
  });

  it('is not called when the loop exits via a stop condition', async () => {
    const generate = createMockGenerate([textResponse('Done')]);

    let handlerCalled = false;
    const summaryGenerate = async () => {
      handlerCalled = true;
      return textResponse('Should not appear');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: (context) => context.toolCalls.length === 0,
      maximumSteps: 10,
      onMaximumSteps: createEarlyStoppingHandler(summaryGenerate),
    });

    expect(handlerCalled).toBe(false);
    expect(result.finishReason).toBe('stop-condition');
  });
});
