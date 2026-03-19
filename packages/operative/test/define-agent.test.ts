import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { defineAgent } from '../src/define-agent';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('defineAgent', () => {
  it('creates an agent with an accessible name', () => {
    const agent = defineAgent({
      name: 'test-agent',
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
    });

    expect(agent.name).toBe('test-agent');
  });

  it('run() with string input creates conversation with system + user messages', async () => {
    let receivedMessages: unknown[] = [];

    const agent = defineAgent({
      name: 'greeter',
      instructions: 'You are a helpful assistant.',
      generate: async ({ conversation }) => {
        receivedMessages = conversation.getMessages();
        return textResponse('Hello!');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const result = await agent.run('Hi there');

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello!');
    expect(receivedMessages).toHaveLength(2);
    expect((receivedMessages[0] as { role: string }).role).toBe('system');
    expect((receivedMessages[1] as { role: string }).role).toBe('user');
  });

  it('run() with Conversation passthrough preserves existing messages', async () => {
    let messageCount = 0;
    const conversation = new Conversation();
    conversation.appendUserMessage('Existing message');

    const agent = defineAgent({
      name: 'passthrough',
      generate: async ({ conversation: conv }) => {
        messageCount = conv.getMessages().length;
        return textResponse('Done');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const result = await agent.run({ conversation });

    expect(result.finishReason).toBe('stop-condition');
    expect(messageCount).toBe(1); // Only the existing message, no system message added
  });

  it('run() returns RunResult with expected fields', async () => {
    const agent = defineAgent({
      name: 'basic',
      generate: async () => textResponse('Result'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const result = await agent.run('test');

    expect(result).toHaveProperty('conversation');
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('usage');
    expect(result).toHaveProperty('finishReason');
    expect(result.content).toBe('Result');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('createRun() returns ActiveRun with events', async () => {
    const agent = defineAgent({
      name: 'event-agent',
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const activeRun = agent.createRun('test');
    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');

    const types = recorder.events.map((e) => e.type);
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');
  });

  it('merges stop conditions from definition and runtime', async () => {
    const finalStep = -1;

    const agent = defineAgent({
      name: 'merge-stop',
      generate: async () => textResponse('step'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    // Runtime stop condition: stop after step 0
    const result = await agent.run({
      conversation: 'test',
      stopWhen: (ctx) => ctx.step >= 0,
    });

    // Both the definition's noToolCalls and the runtime step >= 0 should apply
    expect(result.steps).toHaveLength(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('forwards hooks to the run', async () => {
    const hookLog: string[] = [];

    const weatherTool = createTool({
      name: 'get_weather',
      description: 'Get weather',
      input: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ temperature: 72, location }),
    });

    let callCount = 0;
    const agent = defineAgent({
      name: 'hooked',
      generate: async () => {
        callCount++;
        if (callCount === 1)
          return toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]);
        return textResponse('Done');
      },
      toolbox: createTestToolbox([weatherTool]),
      stopWhen: noToolCalls(),
      prepareStep: async () => {
        hookLog.push('prepareStep');
        return undefined;
      },
      onStep: async () => {
        hookLog.push('onStep');
      },
    });

    await agent.run('Check weather');

    expect(hookLog).toContain('prepareStep');
    expect(hookLog).toContain('onStep');
  });

  it('independent runs get separate conversations', async () => {
    const conversations: Conversation[] = [];

    const agent = defineAgent({
      name: 'independent',
      generate: async ({ conversation }) => {
        conversations.push(conversation);
        return textResponse('Done');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    await agent.run('First');
    await agent.run('Second');

    expect(conversations).toHaveLength(2);
    expect(conversations[0]).not.toBe(conversations[1]);
  });

  it('options property exposes the definition', () => {
    const options = {
      name: 'exposed',
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      maximumSteps: 5,
    };

    const agent = defineAgent(options);

    expect(agent.options.name).toBe('exposed');
    expect(agent.options.maximumSteps).toBe(5);
  });
});
